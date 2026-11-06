import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { AssistantService } from '../src/assistant/service.js';
import { openDatabase } from '../src/database/database.js';
import { MessageRepository, TicketRepository } from '../src/database/repositories.js';
import type { AnswerProvider, AnswerRequest } from '../src/gemini/client.js';
import { shouldHandleMessage, splitDiscordMessage } from '../src/discord/client.js';

class FakeProvider implements AnswerProvider {
  requests: AnswerRequest[] = [];
  async answer(request: AnswerRequest): Promise<string> { this.requests.push(request); return `Answer ${this.requests.length}`; }
}

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
    assert.equal(provider.requests[0]?.context[0]?.source, 'guide.md');
    assert.equal(provider.requests[1]?.history.length, 2);
    await service.ask({ guildId: 'guild-a', userId: 'user-b', question: 'hello' });
    await service.ask({ guildId: 'guild-b', userId: 'user-a', question: 'hello' });
    assert.equal(provider.requests[2]?.history.length, 0);
    assert.equal(provider.requests[3]?.history.length, 0);
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
