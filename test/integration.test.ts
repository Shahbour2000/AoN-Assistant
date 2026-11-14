import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssistantRequestGate, AssistantRateLimitError } from '../src/assistant/service.js';
import { openDatabase } from '../src/database/database.js';
import { MessageRepository, TicketRepository } from '../src/database/repositories.js';
import { shouldHandleMessage, splitDiscordMessage } from '../src/discord/client.js';
import { canCloseTicket, createTicketPermissionOverwrites } from '../src/discord/tickets.js';
import { OverwriteType, PermissionFlagsBits, PermissionOverwrites } from 'discord.js';
import { AonApiClient, AonApiError } from '../src/aon-api/client.js';
import { analyzePlayer, buildPlayerContext } from '../src/aon-api/analysis.js';
import { PlayerLinkService } from '../src/aon-api/linking.js';
import { LinkedPlayerRepository } from '../src/database/repositories.js';
import { selectOnboardingStage, mentorBrief } from '../src/aon-api/onboarding.js';


test('application request gate enforces per-user and global sliding limits with bounded retry time', () => {
  let now = 100_000;
  const gate = new AssistantRequestGate(() => now, 2, 3, 1000);
  gate.admit('g:u1'); gate.admit('g:u1');
  assert.throws(() => gate.admit('g:u1'), (error: unknown) => error instanceof AssistantRateLimitError && error.retryAfterSeconds === 1);
  gate.admit('g:u2');
  assert.throws(() => gate.admit('g:u3'), (error: unknown) => error instanceof AssistantRateLimitError);
  now += 1001;
  assert.doesNotThrow(() => gate.admit('g:u1'));
});

test('onboarding stages adapt to available profile, activity, and company signals', () => {
  assert.equal(selectOnboardingStage(), 'new-player');
  const snapshot = { profile: { id: 'p', username: 'P', level: 4 }, stats: { id: 'p', username: 'P', work: { all: '1' } }, companies: { total: 0, companies: [] }, fetchedAt: 'now' } as any;
  assert.equal(selectOnboardingStage(snapshot), 'early-economy');
  snapshot.companies.companies.push({ name: 'Factory' });
  assert.equal(selectOnboardingStage(snapshot), 'market-business');
  snapshot.profile.level = 15; snapshot.stats.damage = { all: '1' };
  assert.equal(selectOnboardingStage(snapshot), 'military-readiness');
  assert.match(mentorBrief, /not official requirements/u);
  assert.match(mentorBrief, /transfers\/relocation are free/u);
});

test('account linking initializes onboarding persistently and re-link does not reset first-link time', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-onboard-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const links = new LinkedPlayerRepository(db);
    const api = new AonApiClient(async () => new Response(JSON.stringify({ id: 'p1', username: 'Player' }), { status: 200 }));
    const service = new PlayerLinkService(api, links, () => Date.parse('2026-01-01T00:00:00Z'));
    service.confirm((await service.begin('d1', 'Player')).token, 'd1');
    const first = links.getOnboarding('p1')!;
    assert.ok(Number.isFinite(Date.parse(first.startedAt)));
    const firstStartedAt = first.startedAt;
    links.updateOnboarding('p1', 'early-economy', 'welcome');
    service.confirm((await service.begin('d1', 'Player')).token, 'd1');
    assert.equal(links.getOnboarding('p1')?.startedAt, firstStartedAt);
    assert.deepEqual(links.getOnboarding('p1')?.checkpoints, ['welcome']);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('AoN client uses public endpoints, validates used fields, and caches snapshots locally', async () => {
  const urls: string[] = [];
  const api = new AonApiClient(async (input) => {
    const url = String(input); urls.push(url);
    if (url.endsWith('/players/by-name/AbuDujana') || url.endsWith('/players/usr_123')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', level: 26, rank: { code: 'captain' }, countryId: 'eg' }), { status: 200 });
    if (url.endsWith('/stats')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', damage: { all: '1000', week: '20' }, work: { all: '100', week: '30' }, trade: { all: '100', week: '30' } }), { status: 200 });
    return new Response(JSON.stringify({ total: 1, companies: [{ name: 'Bakery', level: 2, investedSteel: 4 }] }), { status: 200 });
  });
  assert.equal((await api.findPlayer('AbuDujana')).id, 'usr_123');
  const snapshot = await api.getSnapshot('usr_123');
  assert.equal(snapshot.stats.damage?.all, '1000');
  assert.equal(snapshot.companies.companies[0]?.name, 'Bakery');
  await api.getSnapshot('usr_123');
  assert.equal(urls.length, 4);
  assert.ok(urls.some((url) => url.includes('/players/by-name/AbuDujana')));
});

test('AoN API failures, missing optional data, and rate limits are handled without unbounded retry', async () => {
  const missing = new AonApiClient(async () => new Response(JSON.stringify({ id: 'usr_123', username: 'Player' }), { status: 200 }));
  assert.equal((await missing.getStats('usr_123')).damage, undefined);
  let calls = 0;
  const limited = new AonApiClient(async () => { calls++; return new Response('busy', { status: 429, headers: { 'retry-after': '60' } }); }, undefined, 1000, 30_000, Date.now, async () => undefined);
  await assert.rejects(limited.findPlayer('Player'), (error: unknown) => error instanceof AonApiError && error.kind === 'rate_limit' && error.retryAfterSeconds === 60);
  assert.equal(calls, 1);
});

test('country API tools use documented search and summary endpoints with object validation', async () => {
  const urls: string[] = [];
  const api = new AonApiClient(async (input) => { urls.push(String(input)); return new Response(JSON.stringify({ country: { id: 'eg', name: 'Egypt' }, citizens: [] }), { status: 200 }); });
  assert.equal(((await api.searchEntities('Egypt')) as Record<string, unknown>).country && urls[0]?.endsWith('/search?q=Egypt'), true);
  assert.equal(((await api.getCountrySummary('eg')) as Record<string, unknown>).country !== undefined, true);
  assert.ok(urls[1]?.endsWith('/countries/eg/summary'));
  const invalid = new AonApiClient(async () => new Response('[]', { status: 200 }));
  assert.deepEqual(await invalid.getCountrySummary('eg'), []);
});

test('live API schemas accept documented array payloads and numeric string company metrics', async () => {
  const api = new AonApiClient(async (input) => {
    const url = String(input);
    if (url.endsWith('/wars?status=active')) return new Response(JSON.stringify([{ id: 'war-1', attackerCountryId: 'eg' }]), { status: 200 });
    if (url.endsWith('/battles?status=active')) return new Response(JSON.stringify([{ id: 'battle-1' }]), { status: 200 });
    if (url.endsWith('/market')) return new Response(JSON.stringify([{ itemCode: 'food', bestAsk: '12' }]), { status: 200 });
    return new Response(JSON.stringify({ total: 1, companies: [{ name: 'Mine', points: '20684', investedSteel: 150 }] }), { status: 200 });
  });
  assert.equal(Array.isArray(await api.getWars()), true);
  assert.equal(Array.isArray(await api.getBattles()), true);
  assert.equal(Array.isArray(await api.getMarket()), true);
  assert.equal((await api.getCompanies('usr_1')).companies[0]?.points, '20684');
});

test('link confirmation is explicitly unverified, conflict-safe, and unlink supports account changes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-link-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const links = new LinkedPlayerRepository(db);
    const api = new AonApiClient(async () => new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', level: 26 }), { status: 200 }));
    const service = new PlayerLinkService(api, links);
    const pending = await service.begin('discord-a', 'AbuDujana');
    assert.throws(() => service.confirm(pending.token, 'discord-b'), /LINK_CONFIRMATION_EXPIRED/u);
    service.confirm(pending.token, 'discord-a');
    assert.equal(links.getByDiscordUser('discord-a')?.verified, false);
    await assert.rejects(service.begin('discord-b', 'AbuDujana'), /PLAYER_ALREADY_LINKED/u);
    assert.equal(links.unlink('discord-a'), true);
    service.confirm((await service.begin('discord-b', 'AbuDujana')).token, 'discord-b');
    assert.equal(links.getByDiscordUser('discord-b')?.playerId, 'usr_123');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('player analysis compares normalized recent momentum and does not invent historical specialization', () => {
  const base = { fetchedAt: '2026-11-06T00:00:00.000Z', profile: { id: 'usr_123', username: 'Player' }, stats: { id: 'usr_123', username: 'Player', damage: { all: '9000000', week: '30', month: '100' }, work: { all: '500000', week: '5', month: '100' }, trade: { all: '800000', week: '5', month: '100' } }, companies: { total: 0, companies: [] } } as const;
  const warMomentum = analyzePlayer(base);
  assert.equal(warMomentum.currentFocus, 'war-focused');
  assert.equal(warMomentum.historicalSpecialization, 'insufficient-data');
  assert.match(warMomentum.historicalExplanation, /unlike units/u);
  const economyMomentum = analyzePlayer({ ...base, stats: { ...base.stats, damage: { all: '1', week: '5', month: '100' }, work: { all: '1', week: '30', month: '100' }, trade: { all: '1', week: '30', month: '100' } } });
  assert.equal(economyMomentum.currentFocus, 'economy-focused');
  const balanced = analyzePlayer({ ...base, stats: { ...base.stats, damage: { all: '100000000', week: '25', month: '100' }, work: { all: '1', week: '25', month: '100' }, trade: { all: '1', week: '25', month: '100' } } });
  assert.equal(balanced.currentFocus, 'hybrid');
  const insufficient = { ...base, stats: { id: 'usr_123', username: 'Player' } };
  assert.equal(analyzePlayer(insufficient).currentFocus, 'insufficient-data');
  assert.equal(analyzePlayer(insufficient).historicalSpecialization, 'insufficient-data');
  assert.match(buildPlayerContext(base), /not verified/u);
  assert.match(buildPlayerContext(base), /historicalSpecialization/u);
});

test('Discord response splitting stays within the configured message size', () => {
  const parts = splitDiscordMessage(`${'Arabic answer.\n'.repeat(80)}`, 300);
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 300));
});

test('message routing only accepts configured channel, bot mentions, and replies to the bot', async () => {
  const base = {
    guildId: 'guild-a', channelId: 'channel-general',
    mentions: { has: () => false },
    reference: null as { messageId: string } | null,
    fetchReference: async () => ({ author: { id: 'bot-a' } }),
  };
  assert.equal(await shouldHandleMessage({ ...base, channelId: 'channel-reception' }, 'bot-a', 'channel-reception'), false);
  assert.equal(await shouldHandleMessage({ ...base, channelId: 'channel-ticket' }, 'bot-a', 'channel-reception'), false);
  assert.equal(await shouldHandleMessage({ ...base, mentions: { has: (id: string) => id === 'bot-a' } }, 'bot-a'), true);
  assert.equal(await shouldHandleMessage({ ...base, reference: { messageId: 'bot-message' } }, 'bot-a'), true);
  assert.equal(await shouldHandleMessage({ ...base, mentions: { has: () => false }, reference: { messageId: 'user-message' }, fetchReference: async () => ({ author: { id: 'user-b' } }) }, 'bot-a'), false);
  assert.equal(await shouldHandleMessage({ ...base, mentions: { has: () => false }, reference: { messageId: 'bot-message' } }, 'bot-a'), true);
  assert.equal(await shouldHandleMessage({ ...base, guildId: null }, 'bot-a', 'channel-assistant'), false);
});

test('ticket records use isolated sessions and persist explicit close state', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-ticket-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const repository = new TicketRepository(db);
    const ticket = { id: 'ticket-1', guildId: 'guild-1', ownerId: 'player-1', channelId: 'channel-1', sessionId: 'ticket-1', status: 'open' as const, createdAt: new Date().toISOString(), closedAt: null };
    repository.create(ticket);
    assert.equal(repository.getByChannel('channel-1')?.ownerId, 'player-1');
    assert.equal(repository.getOpenByOwner('guild-1', 'player-1')?.sessionId, 'ticket-1');
    const messages = new MessageRepository(db);
    messages.appendToSession('ticket-1', 'user', 'Private ticket question');
    assert.equal(messages.listForSession('ticket-1')[0]?.content, 'Private ticket question');
    assert.equal(messages.listForUser('guild-1', 'player-1').length, 0);
    assert.equal(repository.close('ticket-1'), true);
    assert.equal(repository.getOpenByOwner('guild-1', 'player-1'), undefined);
    assert.equal(repository.reopen('ticket-1'), true);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('Discord.js resolves ticket overwrite IDs without querying user or role caches', () => {
  const overwrites = createTicketPermissionOverwrites({
    everyoneId: '100000000000000001', ownerId: '100000000000000002',
    botId: '100000000000000003',
  });
  assert.deepEqual(overwrites.map((overwrite) => overwrite.id), [
    '100000000000000001', '100000000000000002', '100000000000000003',
  ]);
  assert.deepEqual(overwrites.map((overwrite) => overwrite.type), [OverwriteType.Role, OverwriteType.Member, OverwriteType.Member]);
  assert.deepEqual(overwrites[0]?.deny, [PermissionFlagsBits.ViewChannel]);
  assert.ok(overwrites[1]?.allow?.includes(PermissionFlagsBits.ViewChannel));
  assert.ok(overwrites[2]?.allow?.includes(PermissionFlagsBits.ManageChannels));
  const guildWithoutCachedTargets = {
    roles: { resolve: () => { throw new Error('role cache should not be consulted'); } },
    client: { users: { resolve: () => { throw new Error('user cache should not be consulted'); } } },
  };
  const resolved = overwrites.map((overwrite) => PermissionOverwrites.resolve(overwrite, guildWithoutCachedTargets as never));
  assert.deepEqual(resolved.map((overwrite) => overwrite.id), overwrites.map((overwrite) => overwrite.id));
  assert.deepEqual(resolved.map((overwrite) => overwrite.type), overwrites.map((overwrite) => overwrite.type));
});

test('ticket close policy permits owner or Administrator only', () => {
  assert.equal(canCloseTicket('owner', 'owner', false), true);
  assert.equal(canCloseTicket('owner', 'admin', true), true);
  assert.equal(canCloseTicket('owner', 'regular-member', false), false);
});

test('legacy manager role settings are ignored by repository reads and writes', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-legacy-role-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const { GuildSettingsRepository } = await import('../src/database/repositories.js');
    const repository = new GuildSettingsRepository(db);
    const oldShape = { guildId: 'guild-legacy', ticketAdminRoleIds: ['citizen-role-id'] } as never;
    const settings = repository.upsert(oldShape);
    assert.equal(settings.guildId, 'guild-legacy');
    assert.equal('ticketAdminRoleIds' in settings, false);
    assert.deepEqual(repository.get('guild-legacy'), settings);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});
