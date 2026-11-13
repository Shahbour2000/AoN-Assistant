import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssistantRequestGate, AssistantRateLimitError, AssistantService } from '../src/assistant/service.js';
import { openDatabase } from '../src/database/database.js';
import { MessageRepository, TicketRepository } from '../src/database/repositories.js';
import type { AnswerProvider, AnswerRequest } from '../src/groq/client.js';
import { shouldHandleMessage, splitDiscordMessage } from '../src/discord/client.js';
import { canCloseTicket, createTicketPermissionOverwrites } from '../src/discord/tickets.js';
import { OverwriteType, PermissionFlagsBits, PermissionOverwrites } from 'discord.js';
import { buildMessages, classifyGroqResponseError, GroqProvider, GROQ_API_BASE_URL, MAX_COMPLETION_TOKENS } from '../src/groq/client.js';
import { AonApiClient, AonApiError } from '../src/aon-api/client.js';
import { analyzePlayer, buildPlayerContext } from '../src/aon-api/analysis.js';
import { PlayerLinkService } from '../src/aon-api/linking.js';
import { LinkedPlayerRepository } from '../src/database/repositories.js';
import { selectOnboardingStage, mentorBrief } from '../src/aon-api/onboarding.js';
import { classifyIntent, extractPlayerUsername } from '../src/assistant/intent.js';
import { bm25Search } from '../src/assistant/tools.js';
import { apiReferenceChunks } from '../src/knowledge/api-reference.js';

class FakeProvider implements AnswerProvider {
  requests: AnswerRequest[] = [];
  toolResults: unknown[] = [];
  async answer(request: AnswerRequest): Promise<string> {
    this.requests.push(request);
    const call = async (name: string, args: unknown) => { const tool = request.tools?.find((candidate) => candidate.name === name); if (tool) this.toolResults.push(await tool.execute(args)); };
    if (request.question.includes('تعرف توصل') || request.question.includes('تعرف تجيب')) { await call('request_player_username', {}); return 'أيوه طبعًا، ابعتلي اسم اللاعب.'; }
    const username = request.question.match(/(?:ابحث عن|هات بيانات)\s+([A-Za-z0-9_-]+)/u)?.[1] ?? (request.question === 'AbuDujana' ? 'AbuDujana' : undefined);
    if (username) { await call('lookup_player', { username }); const result = this.toolResults.at(-1) as { status?: string }; return result?.status === 'not_found' ? 'ملقتش لاعب بالاسم ده.' : result?.status === 'unavailable' ? 'البيانات مش متاحة دلوقتي.' : 'Player result'; }
    if (request.question.includes('مستواه') || request.question.includes('level') || request.question.includes('Analyze my damage')) { await call('get_selected_player_data', { fields: ['profile', 'stats'] }); return 'Follow-up result'; }
    if (request.question.includes('gather food')) await call('search_knowledge', { query: request.question });
    return `Answer ${this.requests.length}`;
  }
}

test('intent detection separates Egyptian small talk, game news, mechanics and player requests', () => {
  assert.equal(classifyIntent('إيه الأخبار عامل إيه؟'), 'casual');
  assert.equal(classifyIntent('Hey, how are you?'), 'casual');
  assert.equal(classifyIntent('إيه آخر أخبار اللعبة؟'), 'game-news');
  assert.equal(classifyIntent('How do companies work in Age of Nations?'), 'game-mechanics');
  assert.equal(classifyIntent('ابحث عن AbuDujana'), 'player-lookup');
  assert.equal(classifyIntent('مستواه كام؟', true), 'player-followup');
  assert.equal(extractPlayerUsername('AbuDujana', true), 'AbuDujana');
  assert.equal(extractPlayerUsername('إيه الأخبار عامل إيه؟', false), undefined);
  assert.equal(classifyIntent('تعرف تجيب بيانات لاعب لو بعتلك اسمه؟'), 'player-capability');
  assert.equal(extractPlayerUsername('هات بيانات AbuDujana', false), 'AbuDujana');
  assert.equal(extractPlayerUsername('AbuDujana مستواه كام؟', false), 'AbuDujana');
});

test('BM25 knowledge search ranks relevant source and treats unrelated query as insufficient', () => {
  const chunks = [{ source: 'economy.md', heading: 'Companies', content: 'Companies produce goods and require workers.' }, { source: 'war.md', heading: 'Battles', content: 'Battles deal damage during wars.' }];
  assert.equal(bm25Search(chunks, 'companies produce workers')[0]?.source, 'economy.md');
  assert.deepEqual(bm25Search(chunks, 'photosynthesis space telescope'), []);
  assert.equal(apiReferenceChunks({ paths: { '/players/by-name/{username}': { get: { summary: 'Find player' } } } })[0]?.heading, 'GET /players/by-name/{username}');
});

test('BM25 retains repeated term frequency for document ranking', () => {
  const chunks = [{ source: 'a.md', heading: 'Damage', content: 'damage damage damage combat damage' }, { source: 'b.md', heading: 'Damage', content: 'damage economy market' }];
  const rows = bm25Search(chunks, 'damage', 2);
  assert.equal(rows[0]?.source, 'a.md');
});

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

test('Groq provider executes local tool calls in bounded agent loop and returns final answer', async () => {
  const bodies: Array<Record<string, any>> = [];
  let executions = 0;
  const provider = new GroqProvider('key', 'model', 1000, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, any>; bodies.push(body);
    const message = bodies.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'lookup_player', arguments: '{"username":"Player"}' } }] }
      : { role: 'assistant', content: 'Player is level 12.' };
    return new Response(JSON.stringify({ choices: [{ message }] }), { status: 200 });
  });
  const answer = await provider.answer({ question: 'Find Player', context: [], history: [], tools: [{ name: 'lookup_player', description: 'lookup', parameters: { type: 'object' }, execute: async ({ username }) => { executions++; return { username, level: 12 }; } }] });
  assert.equal(answer, 'Player is level 12.');
  assert.equal(executions, 1);
  assert.equal(bodies[0]?.tools[0]?.function?.name, 'lookup_player');
  assert.equal(bodies[1]?.messages.at(-1)?.role, 'tool');
});

test('failed live-data tool short-circuits generation so model cannot fabricate stats', async () => {
  let calls = 0;
  const provider = new GroqProvider('key', 'model', 1000, async () => {
    calls++;
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'lookup_player', arguments: '{"username":"Missing"}' } }] } }] }), { status: 200 });
  });
  const answer = await provider.answer({ question: 'هات بيانات اللاعب Missing', context: [], history: [], tools: [{ name: 'lookup_player', description: 'lookup', parameters: { type: 'object' }, execute: async () => ({ status: 'unavailable', source: { endpoint: '/players/by-name/{username}' } }) }] });
  assert.match(answer, /ماقدرتش أوصل/u);
  assert.equal(calls, 1);
});

test('invalid and rate-limited API tool results are reported distinctly without another model answer', async () => {
  for (const [status, expected] of [['rate_limit', /حد طلبات بيانات اللعبة/u], ['invalid_response', /استجابة بيانات اللعبة غير صالحة/u]] as const) {
    let calls = 0;
    const provider = new GroqProvider('key', 'model', 1000, async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'lookup', type: 'function', function: { name: 'get_game_activity', arguments: '{"kind":"wars","status":"active"}' } }] } }] }), { status: 200 });
    });
    const answer = await provider.answer({ question: 'إيه أخبار الحرب؟', context: [], history: [], tools: [{ name: 'get_game_activity', description: 'activity', parameters: { type: 'object' }, execute: async () => ({ status }) }] });
    assert.match(answer, expected);
    assert.equal(calls, 1);
  }
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

test('assistant retrieves sources, persists context, and isolates guild/user conversations', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-service-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const provider = new FakeProvider();
    const service = new AssistantService(provider, new MessageRepository(db), [
      { source: 'guide.md', heading: 'Economy', content: 'Gather food and wood.' },
    ]);
    assert.equal(await service.ask({ guildId: 'guild-a', userId: 'user-a', question: 'gather food' }), 'Answer 1');
    assert.equal(await service.ask({ guildId: 'guild-a', userId: 'user-a', question: 'what next?' }), 'Answer 2');
    assert.equal((provider.toolResults[0] as { results: Array<{ source: string }> }).results[0]?.source, 'guide.md');
    assert.equal(provider.requests[1]?.history.length, 2);
    await service.ask({ guildId: 'guild-a', userId: 'user-b', question: 'hello' });
    await service.ask({ guildId: 'guild-b', userId: 'user-a', question: 'hello' });
    assert.equal(provider.requests[2]?.history.length, 0);
    assert.equal(provider.requests[3]?.history.length, 0);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('conversation history is isolated by user and channel when Discord supplies channel scope', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-scope-'));
  const db = await openDatabase(path.join(directory, 'db.sqlite'));
  try {
    const provider = new FakeProvider();
    const service = new AssistantService(provider, new MessageRepository(db), []);
    await service.ask({ guildId: 'g', userId: 'u', channelId: 'one', question: 'hello' });
    await service.ask({ guildId: 'g', userId: 'u', channelId: 'two', question: 'hello' });
    await service.ask({ guildId: 'g', userId: 'v', channelId: 'one', question: 'hello' });
    await service.ask({ guildId: 'g', userId: 'u', channelId: 'one', question: 'follow up' });
    assert.equal(provider.requests[3]?.history.length, 2);
    assert.equal(provider.requests[1]?.history.length, 0);
    assert.equal(provider.requests[2]?.history.length, 0);
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
  assert.equal((await api.searchEntities('Egypt')).country && urls[0]?.endsWith('/search?q=Egypt'), true);
  assert.equal((await api.getCountrySummary('eg')).country !== undefined, true);
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

test('assistant memory survives service restart and ticket conversation history stays per Discord user', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-context-restart-'));
  const dbPath = path.join(directory, 'test.sqlite');
  let db = await openDatabase(dbPath);
  try {
    const messages = new MessageRepository(db);
    const provider1 = new FakeProvider();
    const first = new AssistantService(provider1, messages, [], { links: new LinkedPlayerRepository(db), api: new AonApiClient(async (input) => {
      const url = String(input);
      if (url.endsWith('/players/by-name/AbuDujana') || url.endsWith('/players/usr_123')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', level: 22 }), { status: 200 });
      if (url.endsWith('/stats')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana' }), { status: 200 });
      return new Response(JSON.stringify({ total: 0, companies: [] }), { status: 200 });
    }) });
    const ticket = { id: 'ticket-multi', guildId: 'g', ownerId: 'owner', channelId: 'channel', sessionId: 'session', status: 'open' as const, createdAt: new Date().toISOString(), closedAt: null };
    new TicketRepository(db).create(ticket);
    await first.ask({ guildId: 'g', userId: 'u1', channelId: 'channel', conversationId: 'session', question: 'هات بيانات AbuDujana' });
    await first.ask({ guildId: 'g', userId: 'u2', channelId: 'channel', conversationId: 'session', question: 'hello' });
    db.close();
    db = await openDatabase(dbPath);
    const provider2 = new FakeProvider();
    const second = new AssistantService(provider2, new MessageRepository(db), [], { links: new LinkedPlayerRepository(db), api: new AonApiClient(async () => new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', level: 22 }), { status: 200 })) });
    await second.ask({ guildId: 'g', userId: 'u1', channelId: 'channel', conversationId: 'session', question: 'مستواه كام؟' });
    assert.match(provider2.requests[0]?.playerContext ?? '', /AbuDujana/u);
    assert.equal(provider2.requests[0]?.history.length, 2);
    await second.ask({ guildId: 'g', userId: 'u2', channelId: 'channel', conversationId: 'session', question: 'another question' });
    assert.equal(provider2.requests[1]?.history.length, 2);
    assert.equal(provider2.requests[1]?.playerContext, undefined);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
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

test('linked player analysis context reaches the answer provider without losing retrieved knowledge', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-personalized-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const links = new LinkedPlayerRepository(db); links.link('discord-a', 'usr_123', 'Player');
    const api = new AonApiClient(async (input) => String(input).endsWith('/stats')
      ? new Response(JSON.stringify({ id: 'usr_123', username: 'Player', damage: { all: '1000', week: '30', month: '100' }, work: { all: '100', week: '5', month: '100' }, trade: { all: '100', week: '5', month: '100' } }), { status: 200 })
      : String(input).endsWith('/companies?limit=50&sort=invested') ? new Response(JSON.stringify({ total: 0, companies: [] }), { status: 200 })
        : new Response(JSON.stringify({ id: 'usr_123', username: 'Player', level: 4 }), { status: 200 }));
    const provider = new FakeProvider();
    const assistant = new AssistantService(provider, new MessageRepository(db), [{ source: 'war.md', heading: 'Damage', content: 'Combat guidance' }], { links, api });
    await assistant.ask({ guildId: 'g', userId: 'discord-a', question: 'Analyze my damage' });
    assert.match(JSON.stringify(provider.toolResults[0]), /war-focused/u);
    assert.match(JSON.stringify(provider.toolResults[0]), /usr_123/u);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('explicit public username lookup calls API without account linking and supplies live profile context', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-public-lookup-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const calls: string[] = [];
    const api = new AonApiClient(async (input) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/players/by-name/AbuDujana') || url.endsWith('/players/usr_123')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', level: 22, countryId: 'eg' }), { status: 200 });
      if (url.endsWith('/stats')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', damage: { all: '345' } }), { status: 200 });
      return new Response(JSON.stringify({ total: 0, companies: [] }), { status: 200 });
    });
    const provider = new FakeProvider();
    const assistant = new AssistantService(provider, new MessageRepository(db), [], { links: new LinkedPlayerRepository(db), api });
    await assistant.ask({ guildId: 'g', userId: 'u', question: 'ابحث عن AbuDujana' });
    assert.ok(calls.some((url) => url.endsWith('/players/by-name/AbuDujana')));
    assert.match(JSON.stringify(provider.toolResults[0]), /345/u);
    assert.equal(new LinkedPlayerRepository(db).getByDiscordUser('u'), undefined);
    await assistant.ask({ guildId: 'g', userId: 'u', question: 'مستواه كام؟' });
    const followup = JSON.stringify(provider.toolResults.at(-1));
    assert.match(followup, /22/u);
    assert.doesNotMatch(followup, /companyListTotal/u);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('player lookup preserves successful profile and company data when stats endpoint fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-partial-player-'));
  const db = await openDatabase(path.join(directory, 'db.sqlite'));
  try {
    const api = new AonApiClient(async (input) => {
      const url = String(input);
      if (url.endsWith('/players/by-name/AbuDujana') || url.endsWith('/players/usr_123')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', level: 7 }), { status: 200 });
      if (url.endsWith('/stats')) return new Response('temporarily unavailable', { status: 503 });
      return new Response(JSON.stringify({ total: 1, companies: [{ name: 'Mill', level: 2 }] }), { status: 200 });
    });
    const provider = new FakeProvider();
    const assistant = new AssistantService(provider, new MessageRepository(db), [], { links: new LinkedPlayerRepository(db), api });
    await assistant.ask({ guildId: 'g', userId: 'u', question: 'هات بيانات AbuDujana' });
    const result = provider.toolResults[0] as { status: string; data: { profile?: { level?: number }; companies?: { total?: number }; stats?: unknown }; unavailableFields: string[] };
    assert.equal(result.status, 'partial');
    assert.equal(result.data.profile?.level, 7);
    assert.equal(result.data.companies?.total, 1);
    assert.equal(result.data.stats, undefined);
    assert.deepEqual(result.unavailableFields, ['stats']);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('capability question arms channel-scoped username state and bare username performs lookup for follow-ups', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-pending-lookup-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const calls: string[] = [];
    const api = new AonApiClient(async (input) => {
      const url = String(input); calls.push(url);
      if (url.endsWith('/players/by-name/AbuDujana') || url.endsWith('/players/usr_123')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', level: 22, countryId: 'eg' }), { status: 200 });
      if (url.endsWith('/stats')) return new Response(JSON.stringify({ id: 'usr_123', username: 'AbuDujana', damage: { all: '77', week: '5' }, work: { all: '9' } }), { status: 200 });
      return new Response(JSON.stringify({ total: 0, companies: [] }), { status: 200 });
    });
    const provider = new FakeProvider();
    const assistant = new AssistantService(provider, new MessageRepository(db), [], { links: new LinkedPlayerRepository(db), api });
    assert.match(await assistant.ask({ guildId: 'g', userId: 'u', channelId: 'c1', question: 'تعرف توصل لبيانات لاعب معين لو بعتلك الاسم؟' }), /ابعتلي اسم اللاعب/u);
    assert.equal(calls.length, 0);
    await assistant.ask({ guildId: 'g', userId: 'u', channelId: 'c1', question: 'AbuDujana' });
    assert.ok(calls.some((url) => url.endsWith('/players/by-name/AbuDujana')));
    await assistant.ask({ guildId: 'g', userId: 'u', channelId: 'c1', question: "What's his level?" });
    assert.match(provider.requests.at(-1)?.playerContext ?? '', /AbuDujana/u);
    assert.match(JSON.stringify(provider.toolResults.at(-1)), /22/u);
    const before = calls.length;
    await assistant.ask({ guildId: 'g', userId: 'u', channelId: 'c2', question: "What's his level?" });
    assert.equal(calls.length, before);
    assert.equal(provider.requests.at(-1)?.playerContext, undefined);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test('username lookup distinguishes exact not-found from API failure before the model can invent an outcome', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-lookup-errors-'));
  const db = await openDatabase(path.join(directory, 'test.sqlite'));
  try {
    const links = new LinkedPlayerRepository(db);
    const notFoundApi = new AonApiClient(async () => new Response('{}', { status: 404 }));
    const provider = new FakeProvider();
    const notFound = new AssistantService(provider, new MessageRepository(db), [], { links, api: notFoundApi });
    assert.match(await notFound.ask({ guildId: 'g', userId: 'a', question: 'هات بيانات MissingPlayer' }), /ملقتش لاعب/u);
    const failedApi = new AonApiClient(async () => new Response('busy', { status: 503 }));
    const failed = new AssistantService(provider, new MessageRepository(db), [], { links, api: failedApi });
    assert.match(await failed.ask({ guildId: 'g', userId: 'b', question: 'هات بيانات BusyPlayer' }), /البيانات مش متاحة/u);
    assert.equal((provider.toolResults[0] as { status: string }).status, 'not_found');
    assert.equal((provider.toolResults[1] as { status: string }).status, 'unavailable');
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
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

test('Groq request uses model, endpoint, key, bounded relevant context, and preserves Arabic behavior', async () => {
  let url = '';
  let init: RequestInit | undefined;
  const provider = new GroqProvider('test-groq-key', 'qwen/qwen3.8-27b', 1000, async (input, options) => {
    url = String(input); init = options;
    return new Response(JSON.stringify({ choices: [{ message: { content: 'إجابة عربية' } }] }), { status: 200 });
  });
  const answer = await provider.answer({ question: 'كيف أبدأ؟', context: [{ source: 'guide.md', heading: 'البداية', content: 'خطوات البداية' }], history: [] });
  assert.equal(url, `${GROQ_API_BASE_URL}/chat/completions`);
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer test-groq-key');
  const payload = JSON.parse(String(init?.body)) as { model: string; max_tokens: number; messages: Array<{ role: string; content: string }> };
  assert.equal(payload.model, 'qwen/qwen3.8-27b');
  assert.equal(payload.max_tokens, MAX_COMPLETION_TOKENS);
  assert.equal(payload.messages[0]?.role, 'system');
  assert.match(payload.messages[0]?.content ?? '', /guide\.md — البداية/u);
  assert.match(payload.messages[0]?.content ?? '', /natural Arabic \(including Egyptian dialect\)/u);
  assert.equal(payload.messages.at(-1)?.content, 'كيف أبدأ؟');
  assert.equal(answer, 'إجابة عربية');
});

test('Groq classifies auth, permission, rate-limit, and server failures without retries', async () => {
  for (const [status, kind] of [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limit'], [503, 'unavailable']] as const) {
    let attempts = 0;
    const provider = new GroqProvider('mock-key', 'qwen/qwen3.8-27b', 1000, async () => {
      attempts++;
      return new Response(JSON.stringify({ error: { code: `E${status}`, message: 'safe provider detail' } }), {
        status, headers: status === 429 ? { 'retry-after': '7' } : undefined,
      });
    });
    await assert.rejects(provider.answer({ question: 'test', context: [], history: [] }), (error: unknown) => {
      assert.equal((error as { kind: string }).kind, kind);
      assert.equal((error as { httpStatus: number }).httpStatus, status);
      if (status === 429) assert.equal((error as { retryAfterSeconds: number }).retryAfterSeconds, 7);
      return true;
    });
    assert.equal(attempts, 1);
  }
  assert.equal(classifyGroqResponseError(429, '{"error":{"message":"busy"}}', '2').retryAfterSeconds, 2);
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
