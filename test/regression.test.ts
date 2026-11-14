/**
 * Regression tests for conversations that failed in real Discord testing (Nov 2026). They use the REAL wiki files and a scripted model,
 * so they prove the plumbing around the model (retrieval, prompt budget, retries, error text) — not that a live model phrases answers well.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { failureMessage } from '../src/discord/failure.js';
import { AssistantService, AssistantRequestGate, prefetchQueries } from '../src/assistant/service.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { createTools } from '../src/agent/tools/index.js';
import { MessageRepository } from '../src/database/repositories.js';
import { KnowledgeBase, parseGlossary } from '../src/knowledge/index.js';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible.js';
import { PROVIDER_PRESETS } from '../src/llm/presets.js';
import { estimateMessagesTokens, estimateTokens } from '../src/llm/tokens.js';
import { LlmError } from '../src/llm/types.js';
import { openTestDatabase } from './helpers/sqlite-compat.js';
import { ScriptedLlm } from './helpers/scripted-llm.js';

const gate = () => new AssistantRequestGate(() => 0, 1000, 1000, 60_000);
const toolText = (llm: ScriptedLlm, index = 0) => llm.requests[index]!.messages.filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
async function setup(llm: ScriptedLlm) {
  const db = openTestDatabase();
  const knowledge = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
  return { db, knowledge, service: new AssistantService({ llm, messages: new MessageRepository(db), knowledge, requestGate: gate() }) };
}

test('"عايز اعرف ازاي اقدر اغير مكان الشركة": the wiki sentence saying a company cannot be moved reaches the model in ONE model call', async () => {
  const llm = new ScriptedLlm([{ content: 'مينفعش تنقل الشركة، بتفضل في المنطقة اللي اتبنت فيها.' }]);
  const { db, service } = await setup(llm);
  const answer = await service.ask({ guildId: 'g', userId: 'u', question: 'عايز اعرف ازاي اقدر اغير مكان الشركة', channelId: 'c' });
  assert.match(answer, /مينفعش/u);
  assert.equal(llm.requests.length, 1, 'no extra model round trip just to run a search');
  assert.match(toolText(llm), /لا يمكن نقل الشركة/u, 'the exact wiki rule was supplied to the model');
  db.close();
});

test('company rename question gets the wiki rename row (free) in the first model call', async () => {
  for (const question of ['ازاي اغير اسم الشركة بتاعتي؟', 'عايز اغير اسم شركتي']) {
    const llm = new ScriptedLlm([{ content: 'تقدر تغيّر الاسم من تبويب أدِر وهو مجاني.' }]);
    const { db, service } = await setup(llm);
    await service.ask({ guildId: 'g', userId: 'u', question, channelId: 'c' });
    assert.equal(llm.requests.length, 1);
    assert.match(toolText(llm), /إعادة التسمية \| مجاني/u, question);
    db.close();
  }
});

test('greetings and thanks run no wiki search and a single model call', async () => {
  for (const question of ['ازيك يا باشا', 'شكرا ليك']) {
    const llm = new ScriptedLlm([{ content: 'أهلاً بيك!' }]);
    const { db, service } = await setup(llm);
    await service.ask({ guildId: 'g', userId: 'u', question, channelId: 'c' });
    assert.equal(llm.requests.length, 1);
    assert.equal(llm.requests[0]!.messages.some((m) => m.role === 'tool'), false, `no passages injected for "${question}"`);
    db.close();
  }
});

test('an empty reply caused by the token budget (finish_reason=length) is retried with a bigger budget, not turned into an error', async () => {
  const llm = new ScriptedLlm([{ content: '', finishReason: 'length' }, { content: 'مينفعش تنقل الشركة.' }]);
  const { db, service } = await setup(llm);
  const answer = await service.ask({ guildId: 'g', userId: 'u', question: 'عايز اعرف ازاي اقدر اغير مكان الشركة', channelId: 'c' });
  assert.match(answer, /مينفعش/u);
  assert.equal(llm.requests.length, 2);
  assert.ok((llm.requests[1]!.maxTokens ?? 0) > (llm.requests[0]!.maxTokens ?? 0), 'second attempt gets a larger max_tokens');
  db.close();
});

test('a model that keeps returning nothing fails with a specific, typed error (and a specific Discord message), after bounded retries', async () => {
  const llm = new ScriptedLlm([{ content: '', finishReason: 'stop' }]);
  const { db, service } = await setup(llm);
  await assert.rejects(() => service.ask({ guildId: 'g', userId: 'u', question: 'سؤال', channelId: 'c' }), (error: unknown) => error instanceof LlmError && error.kind === 'invalid_response');
  assert.equal(llm.requests.length, 3, 'one try plus two retries, never an endless loop');
  assert.match(failureMessage('invalid_response'), /رد فاضي/u);
  assert.notEqual(failureMessage('invalid_response'), failureMessage('unknown'));
  assert.match(failureMessage('rate_limit', 15), /15 ثانية/u);
  db.close();
});

test('token budget: a wiki question fits a free tier with an 8,000 tokens/minute ceiling in ONE call (the limit that blocked the bot)', async () => {
  const knowledge = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
  const tools = createTools({ knowledge, api: { getJson: async () => ({}) } });
  const system = buildSystemPrompt({ now: new Date(), knowledgeOutline: knowledge.outline(), hasKnowledge: true, hasGameApi: true });
  const toolTokens = tools.reduce((sum, tool) => sum + estimateTokens(JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters })), 0);
  const search = await tools.find((t) => t.name === 'search_knowledge')!.execute({ queries: ['طيب لو عايز اعمل شركة تالتة محتاج كام حديد؟'], limit: 4 }, { knowledge, getActivePlayer: () => undefined, setActivePlayer: () => undefined, now: () => 0 } as never);
  const total = estimateMessagesTokens([{ content: system }, { content: 'طيب لو عايز اعمل شركة تالتة محتاج كام حديد؟' }, { content: JSON.stringify(search) }]) + toolTokens + 600;
  console.log(`# estimated tokens for one wiki-grounded call: ${total} (system ${estimateTokens(system)}, tools ${toolTokens})`);
  assert.ok(total < 7000, `one wiki-grounded call is estimated at ${total} tokens; must stay under 7000 to fit an 8000 tokens/minute limit`);
});

test('the local limiter reserves a realistic completion size, so a normal call is not mistaken for a 2-3x larger one', async () => {
  let sent = 0;
  const fetcher = async () => { sent++; return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3500, completion_tokens: 40 } }), { status: 200 }); };
  const provider = new OpenAiCompatibleProvider({ name: 'groq', baseUrl: 'https://x/v1', apiKey: 'k', model: 'm', limits: PROVIDER_PRESETS.groq!.limits }, fetcher as never);
  // 3,500-token prompt + max_tokens 1,400: reserving all 1,400 made two such calls impossible inside 8,000 tokens/minute.
  const prompt = [{ role: 'user' as const, content: 'x'.repeat(3500 * 3) }];
  await provider.chat({ messages: prompt, maxTokens: 1400 });
  await provider.chat({ messages: prompt, maxTokens: 1400 });
  assert.equal(sent, 2);
});

test('follow-ups keep their topic: a short message is searched together with the previous question', () => {
  assert.deepEqual(prefetchQueries('والتالتة؟', 'عايز اعمل شركة تانية'), ['والتالتة؟', 'عايز اعمل شركة تانية والتالتة؟']);
  assert.deepEqual(prefetchQueries('اشرحلي بالتفصيل ازاي بتشتغل الحروب في اللعبة وايه المراحل', 'x'), ['اشرحلي بالتفصيل ازاي بتشتغل الحروب في اللعبة وايه المراحل']);
});

test('glossary tables are a data-driven synonym map for keyword search (new slang = new table row, no code)', async () => {
  const rows = parseGlossary('| قال اللاعب | مصطلح الويكي |\n|---|---|\n| اسم الشركة، غير اسم | إعادة التسمية |\n| ضرر | الضرر damage |');
  assert.equal(rows.length, 1, 'a row whose slang already equals the wiki word adds nothing and is dropped');
  const knowledge = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
  const result = await knowledge.search(['ازاي اغير اسم الشركة'], { limit: 3 });
  assert.match(result.hits[0]!.heading, /إعادة التسمية/u);
});
