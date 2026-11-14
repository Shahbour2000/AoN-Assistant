import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ConversationMemory } from '../src/agent/memory.js';
import { AssistantRateLimitError, AssistantRequestGate, AssistantService } from '../src/assistant/service.js';
import { MessageRepository } from '../src/database/repositories.js';
import { KnowledgeBase } from '../src/knowledge/index.js';
import { LlmError } from '../src/llm/types.js';
import { openTestDatabase } from './helpers/sqlite-compat.js';
import { call, ScriptedLlm } from './helpers/scripted-llm.js';

const apiOk = { getJson: async (p: string) => { if (p === '/players/by-name/Egyptian') return { id: 'usr_abc123def456', username: 'Egyptian', level: 47, damage: { total: '9876543' } }; if (p === '/players/usr_abc123def456/stats') return { damage: { all: '9876543' } }; throw Object.assign(new Error('x'), { kind: 'not_found' }); } };
const scope = (channel: string) => ({ channelId: channel, conversationId: `conv-${channel}` });

test('follow-ups see earlier turns; two users and two channels never share history', async () => {
  const db = openTestDatabase();
  const messages = new MessageRepository(db);
  const llm = new ScriptedLlm([{ content: 'رد 1' }]);
  const service = new AssistantService({ llm, messages });
  await service.ask({ guildId: 'g', userId: 'u1', question: 'انا جديد في اللعبة', ...scope('c1') });
  await service.ask({ guildId: 'g', userId: 'u1', question: 'والشركات؟', ...scope('c1') });
  const second = llm.requests[1]!.messages.map((m) => m.content).join('\n');
  assert.match(second, /انا جديد في اللعبة/u);
  assert.match(second, /رد 1/u);
  await service.ask({ guildId: 'g', userId: 'u2', question: 'سؤال سري', ...scope('c2') });
  await service.ask({ guildId: 'g', userId: 'u1', question: 'ايه الجديد', ...scope('c3') });
  const other = llm.requests[3]!.messages.map((m) => m.content).join('\n');
  assert.doesNotMatch(other, /سؤال سري|انا جديد/u, 'a different channel starts clean');
  const u2 = llm.requests[2]!.messages.map((m) => m.content).join('\n');
  assert.doesNotMatch(u2, /انا جديد|والشركات/u, 'another user never sees u1 history');
  db.close();
});

test('active player persists across turns in the same conversation only (public lookup, no account linking)', async () => {
  const db = openTestDatabase();
  const llm = new ScriptedLlm([
    { toolCalls: [call('find_player', { username: 'Egyptian' })] }, { content: 'مستواه 47.' },
    { toolCalls: [call('get_player_data', { include: ['stats'] })] }, { content: 'الضرر 9876543.' },
    { content: 'مين؟' },
  ]);
  const service = new AssistantService({ llm, messages: new MessageRepository(db), api: apiOk });
  await service.ask({ guildId: 'g', userId: 'u1', question: 'هات بيانات Egyptian', ...scope('c1') });
  const answer = await service.ask({ guildId: 'g', userId: 'u1', question: 'والضرر بتاعه؟', ...scope('c1') });
  assert.match(answer, /9876543/u);
  assert.match(llm.requests[2]!.messages[0]!.content!, /Active player in this conversation: Egyptian \(id usr_abc123def456/u);
  const statsCall = llm.requests[3]!.messages.find((m) => m.role === 'tool')!.content!;
  assert.match(statsCall, /"all":"9876543"/u);
  await service.ask({ guildId: 'g', userId: 'u2', question: 'والضرر بتاعه؟', ...scope('c9') });
  assert.doesNotMatch(llm.requests[4]!.messages[0]!.content!, /Active player/u);
  db.close();
});

test('wiki-grounded answer end to end; unsupported numbers get an honesty caveat in the player\'s language', async () => {
  const db = openTestDatabase();
  const kb = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
  const llm = new ScriptedLlm([{ toolCalls: [call('search_knowledge', { queries: ['شركة'] })] }, { content: 'بتكلف 7777777 ذهب.' }, { content: 'بتكلف 7777777 ذهب.' }]);
  const service = new AssistantService({ llm, messages: new MessageRepository(db), knowledge: kb });
  const answer = await service.ask({ guildId: 'g', userId: 'u1', question: 'الشركة بكام؟' });
  assert.match(answer, /مقدرتش أتأكد/u);
  assert.match(llm.requests[0]!.messages[0]!.content!, /02-economy\.md/u, 'wiki outline is in the prompt');
  db.close();
});

test('long conversations are summarised; later requests get the summary plus only recent turns', async () => {
  const db = openTestDatabase();
  const messages = new MessageRepository(db);
  const llm = new ScriptedLlm([(r) => ({ content: r.messages[0]?.content?.includes('running memory') ? 'MEMORY: player is new, wants economy tips' : 'ok' })]);
  const service = new AssistantService({ llm, messages, requestGate: new AssistantRequestGate(() => 0, 1000, 1000, 60_000) });
  for (let i = 0; i < 12; i++) await service.ask({ guildId: 'g', userId: 'u1', question: `سؤال رقم ${i}`, ...scope('c1') });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const sessionId = messages.findSessionId('g', 'u1', JSON.stringify(['c1', 'conv-c1']))!;
  assert.match(messages.getSummary(sessionId)?.summary ?? '', /MEMORY/u);
  await service.ask({ guildId: 'g', userId: 'u1', question: 'سؤال أخير', ...scope('c1') });
  const last = llm.requests.at(-1)!;
  assert.match(last.messages[0]!.content!, /MEMORY: player is new/u);
  const history = last.messages.filter((m) => m.role !== 'system').map((m) => m.content).join('\n');
  assert.doesNotMatch(history, /سؤال رقم 0\b/u, 'folded turns are not resent verbatim');
  assert.match(history, /سؤال رقم 11/u);
  db.close();
});

test('memory keeps whole messages within the token budget and a failing summariser never breaks answering', async () => {
  const db = openTestDatabase();
  const messages = new MessageRepository(db);
  for (let i = 0; i < 30; i++) { messages.appendForUser({ guildId: 'g', userId: 'u', role: 'user', content: `${'كلمة '.repeat(60)}#${i}`, createdAt: new Date().toISOString() }); }
  const memory = new ConversationMemory(messages, { historyTokens: 400 });
  const loaded = memory.load('g', 'u');
  assert.ok(loaded.messages.length >= 2 && loaded.messages.length < 10);
  assert.ok(loaded.messages.at(-1)!.content!.endsWith('#29'));
  const failing = new ScriptedLlm([() => { throw new LlmError('timeout', 't'); }]);
  assert.equal(await memory.maybeSummarise(loaded.sessionId!, failing), false);
  db.close();
});

test('provider failures propagate as typed errors (Discord layer shows a friendly message), and the application gate still limits users', async () => {
  const db = openTestDatabase();
  const llm = new ScriptedLlm([() => { throw new LlmError('rate_limit', 'slow down', { retryAfterSeconds: 12 }); }]);
  const service = new AssistantService({ llm, messages: new MessageRepository(db), requestGate: new AssistantRequestGate(() => 0, 2, 100, 60_000) });
  await assert.rejects(() => service.ask({ guildId: 'g', userId: 'u1', question: 'x' }), (e: unknown) => e instanceof LlmError && e.retryAfterSeconds === 12);
  await assert.rejects(() => service.ask({ guildId: 'g', userId: 'u1', question: 'x' }), LlmError);
  await assert.rejects(() => service.ask({ guildId: 'g', userId: 'u1', question: 'x' }), AssistantRateLimitError);
  db.close();
});
