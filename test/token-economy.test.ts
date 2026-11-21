/** Tests for the "responsive under free quotas" work: limiter diagnostics, failover, token economy, cache, messages. */
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { AnswerCache } from '../src/agent/cache.js';
import { runAgent } from '../src/agent/loop.js';
import { isSmallTalk, needsLiveData } from '../src/agent/routing.js';
import { createTools, type ToolContext } from '../src/agent/tools/index.js';
import { failureMessage } from '../src/discord/failure.js';
import { KnowledgeBase, parseGlossary } from '../src/knowledge/index.js';
import { FailoverProvider } from '../src/llm/failover.js';
import { LocalLimiter } from '../src/llm/limiter.js';
import { buildLlm, defaultChain } from '../src/llm/presets.js';
import { estimateMessagesTokens } from '../src/llm/tokens.js';
import { LlmError, type ChatRequest, type LlmProvider } from '../src/llm/types.js';
import { call, ScriptedLlm } from './helpers/scripted-llm.js';

const noSleep = async () => undefined;
const fake = (id: string, behaviour: () => Promise<{ content: string }>): LlmProvider & { calls: number } => {
  const p = { id, calls: 0, async chat(_r: ChatRequest) { p.calls++; const r = await behaviour(); return { content: r.content, toolCalls: [], provider: id, model: 'm' }; } };
  return p as never;
};
const limited = (seconds: number) => new LlmError('rate_limit', 'limited', { retryAfterSeconds: seconds, source: 'provider_429', reachedProvider: true });

// ------------------------------------------------------------------ limiter diagnostics
test('local limiter explains which limit blocked, how much was needed/used, and that nothing reached the provider', async () => {
  let now = 0;
  const limiter = new LocalLimiter({ tpm: 8000 }, () => now, noSleep, 1_000);
  await limiter.acquire(5000, 'groq', 'm');
  const error = await limiter.acquire(5000, 'groq', 'm').catch((e) => e as LlmError);
  assert.ok(error instanceof LlmError);
  assert.equal(error.kind, 'rate_limit');
  assert.equal(error.source, 'local_limiter');
  assert.equal(error.details.reachedProvider, false);
  assert.equal(error.details.limit, 'tpm');
  assert.equal(error.details.requestedTokens, 5000);
  assert.equal(error.details.usedTokens, 5000);
  assert.equal(error.details.maxTokens, 8000);
  assert.equal(error.retryAfterSeconds, 60);
  assert.match(error.message, /TPM/u);
  assert.match(error.message, /Nothing was sent to the provider/u);
  now = 61_000; // the window slides
  await limiter.acquire(5000, 'groq', 'm');
});

test('a provider 429 is reported as reaching the provider (distinct from a local block)', () => {
  assert.equal(limited(5).details.reachedProvider, true);
  assert.equal(limited(5).source, 'provider_429');
});

// ------------------------------------------------------------------ failover
test('a rate-limited provider is skipped until its cooldown ends, and the next free provider serves immediately', async () => {
  let now = 0;
  let aFails = true;
  const a = fake('a', async () => { if (aFails) throw limited(30); return { content: 'from a' }; });
  const b = fake('b', async () => ({ content: 'from b' }));
  const chain = new FailoverProvider([a, b], { now: () => now, sleep: noSleep });
  assert.equal((await chain.chat({ messages: [] })).content, 'from b');
  assert.equal(a.calls, 1);
  assert.equal((await chain.chat({ messages: [] })).content, 'from b');
  assert.equal(a.calls, 1, 'a is skipped during its cooldown, not called again');
  assert.equal(chain.status()[0]!.availableInSeconds, 30);
  now = 31_000; aFails = false;
  assert.equal((await chain.chat({ messages: [] })).content, 'from a');
});

test('failure other than rate limit (timeout, 5xx) also fails over', async () => {
  const a = fake('a', async () => { throw new LlmError('timeout', 't'); });
  const b = fake('b', async () => ({ content: 'ok' }));
  assert.equal((await new FailoverProvider([a, b], { sleep: noSleep }).chat({ messages: [] })).content, 'ok');
});

test('when every provider is briefly limited it waits once, then answers; it never loops', async () => {
  let now = 0;
  let slept = 0;
  const mk = (id: string, ok: () => boolean) => fake(id, async () => { if (!ok()) throw limited(10); return { content: id }; });
  const a = mk('a', () => now >= 10_000), b = mk('b', () => now >= 10_000);
  const chain = new FailoverProvider([a, b], { now: () => now, sleep: async (ms) => { slept++; now += ms; }, maxWaitMs: 45_000 });
  assert.equal((await chain.chat({ messages: [] })).content, 'a');
  assert.equal(slept, 1);
});

test('when every provider is limited for long, one aggregate rate_limit error with the real remaining time is thrown', async () => {
  const a = fake('a', async () => { throw limited(3600); });
  const b = fake('b', async () => { throw limited(120); });
  const error = await new FailoverProvider([a, b], { sleep: noSleep }).chat({ messages: [] }).catch((e) => e as LlmError);
  assert.ok(error instanceof LlmError);
  assert.equal(error.kind, 'rate_limit');
  assert.equal(error.source, 'all_providers');
  assert.equal(error.retryAfterSeconds, 120, 'reports the soonest recovery, not the longest');
  assert.match(error.message, /a .*b /u);
});

test('an unconfigured provider is not in the chain; a configured one is; LLM_BACKUP=auto adds the rest without duplicates', () => {
  assert.deepEqual(defaultChain({ GROQ_API_KEY: 'x' }).map((s) => s.provider), ['groq', 'groq']);
  const both = defaultChain({ GROQ_API_KEY: 'x', CLOUDFLARE_API_TOKEN: 'y', CLOUDFLARE_ACCOUNT_ID: 'z' });
  assert.deepEqual(both.map((s) => `${s.provider}`), ['groq', 'cloudflare', 'groq']);
  assert.deepEqual(defaultChain({ CLOUDFLARE_API_TOKEN: 'y' }), [], 'Cloudflare without an account id is not available');
  assert.deepEqual(defaultChain({}), []);
  const env = { GROQ_API_KEY: 'x', CLOUDFLARE_API_TOKEN: 'y', CLOUDFLARE_ACCOUNT_ID: 'z', LLM_PRIMARY: 'groq:qwen/qwen3.8-27b', LLM_BACKUP: 'auto' };
  const specs = buildLlm(env).specs.map((s) => `${s.provider}:${s.model}`);
  assert.equal(new Set(specs).size, specs.length);
  assert.ok(specs.some((s) => s.startsWith('cloudflare:')));
  assert.throws(() => buildLlm({}), /No language model/u);
});

// ------------------------------------------------------------------ routing
test('small talk is detected only for pure greetings; real questions are never small talk', () => {
  for (const text of ['السلام عليكم ورحمة الله وبركاته', 'hello', 'شكرا', 'ازيك يا باشا']) assert.equal(isSmallTalk(text), true, text);
  for (const text of ['عايز اعرف كل ما بزيد مستوى باخد كام نقاط مهارات؟', 'hello how many skill points per level', 'شكرا بس كام حديد للشركة التالتة']) assert.equal(isSmallTalk(text), false, text);
});

test('live-data intent is detected; wiki-only questions are not', () => {
  assert.equal(needsLiveData('عايز اعرف كل ما بزيد مستوى، باخد كام نقاط مهارات؟'), false);
  assert.equal(needsLiveData('how many skill points per level'), false);
  assert.equal(needsLiveData('مين اعلى لاعب دلوقتي'), true);
  assert.equal(needsLiveData('what is the price of steel'), true);
  assert.equal(needsLiveData('ابحث عن لاعب Egyptian'), true, 'a Latin word inside Arabic may be a username');
});

// ------------------------------------------------------------------ agent economy
const ctx = (knowledge: KnowledgeBase): ToolContext => ({ knowledge, getActivePlayer: () => undefined, setActivePlayer: () => undefined, now: () => 0 }) as never;
let kbPromise: Promise<KnowledgeBase> | undefined;
const realKb = () => (kbPromise ??= KnowledgeBase.create({ dir: path.resolve('knowledge') }));

test('small talk: one cheap call, no tools, no wiki search', async () => {
  const kb = await realKb();
  const llm = new ScriptedLlm([{ content: 'وعليكم السلام!' }]);
  const out = await runAgent({ llm, tools: createTools({ knowledge: kb }), toolContext: ctx(kb) }, { system: 'sys', history: [], userMessage: 'السلام عليكم', smallTalk: true });
  assert.equal(out.llmCalls, 1);
  assert.equal(llm.requests[0]!.tools?.length ?? 0, 0);
  assert.ok(estimateMessagesTokens(llm.requests[0]!.messages) < 600);
});

test('wiki question: ONE model call with wiki passages prefetched and the lean tool set', async () => {
  const kb = await realKb();
  const llm = new ScriptedLlm([{ content: 'كل مستوى جديد يعطيك 4 نقاط مهارة و 5 ذهب.' }]);
  const lean = createTools({ knowledge: kb }).filter((t) => ['search_knowledge', 'calculate'].includes(t.name));
  const out = await runAgent({ llm, tools: createTools({ knowledge: kb }), leanTools: lean, toolContext: ctx(kb) }, { system: 'sys', history: [], userMessage: 'كل مستوى باخد كام نقطة مهارة؟', prefetchQueries: ['skill points per level نقاط المهارة', 'level up'], preferLean: true });
  assert.equal(out.llmCalls, 1);
  assert.equal(out.revisions, 0);
  const names = (llm.requests[0]!.tools ?? []).map((t) => t.name);
  assert.ok(names.length > 0 && names.length <= 2, names.join(','));
  assert.ok(estimateMessagesTokens(llm.requests[0]!.messages) < 3200, 'prompt stays small');
});

test('if the revision call fails (provider limited), the already-written draft is returned instead of an error', async () => {
  const kb = await realKb();
  let n = 0;
  const llm: LlmProvider = { id: 'x', async chat() { n++; if (n === 1) return { content: 'ستحصل على 999 نقطة مهارة.', toolCalls: [], provider: 'x', model: 'm' }; throw limited(40); } };
  const out = await runAgent({ llm, tools: createTools({ knowledge: kb }), toolContext: ctx(kb) }, { system: 's', history: [], userMessage: 'كل مستوى باخد كام نقطة مهارة؟', prefetchQueries: ['نقاط المهارة'] });
  assert.ok(out.answer.length > 0, 'a draft is returned');
  assert.ok(out.unresolvedIssues.length > 0, 'the issue is still reported, not hidden');
});

test('answer cache: equivalent requests are reused; any difference in context or user history is a miss', async () => {
  const kb = await realKb();
  const cache = new AnswerCache<{ answer: string; provider: string }>();
  const run = (history: Array<{ role: 'user' | 'assistant'; content: string }>, text = 'كل مستوى باخد كام نقطة مهارة؟', system = 'sys') => {
    const llm = new ScriptedLlm([{ content: 'كل مستوى جديد يعطيك 4 نقاط مهارة و 5 ذهب.' }]);
    return runAgent({ llm, tools: createTools({ knowledge: kb }), toolContext: ctx(kb), answerCache: cache }, { system, history, userMessage: text, prefetchQueries: ['نقاط المهارة'] }).then((out) => ({ out, llm }));
  };
  const first = await run([]);
  assert.equal(first.out.llmCalls, 1);
  const second = await run([]);
  assert.equal(second.out.cached, true);
  assert.equal(second.llm.requests.length, 0, 'no model call on a cache hit');
  assert.equal((await run([{ role: 'user', content: 'private earlier message' }])).llm.requests.length, 1, 'different history => miss');
  assert.equal((await run([], 'كل مستوى باخد كام نقطة مهارة؟', 'other system (e.g. other active player)')).llm.requests.length, 1, 'different system prompt => miss');
  assert.equal((await run([], 'كام نقطة مهارة عند مستوى 5؟')).llm.requests.length, 1, 'different question => miss');
});

test('cache entries expire and the cache is bounded', () => {
  let now = 0;
  const cache = new AnswerCache<string>(1000, 2, () => now);
  cache.set('a', '1'); cache.set('b', '2'); cache.set('c', '3');
  assert.equal(cache.get('a'), undefined, 'oldest evicted');
  assert.equal(cache.get('c'), '3');
  now = 1001;
  assert.equal(cache.get('c'), undefined, 'expired');
  assert.notEqual(AnswerCache.key({ q: 1 }), AnswerCache.key({ q: 2 }));
});

// ------------------------------------------------------------------ messages
test('Arabic failure messages say what actually happened', () => {
  assert.match(failureMessage('app_limit', 12), /12 ثانية/u);
  assert.match(failureMessage('app_limit', 12), /رسايل كتير/u);
  assert.doesNotMatch(failureMessage('app_limit', 12), /الذكاء الاصطناعي/u, 'our own anti-spam gate is not blamed on the AI providers');
  assert.match(failureMessage('rate_limit', 30), /30 ثانية/u);
  assert.match(failureMessage('rate_limit', 600), /10 دقيقة/u);
  assert.match(failureMessage('rate_limit', 5 * 3600), /5 ساعة/u);
  assert.match(failureMessage('rate_limit', 5 * 3600), /اليومية/u);
  assert.match(failureMessage('rate_limit'), /شوية/u);
  assert.match(failureMessage('timeout'), /مش بترد/u);
  assert.match(failureMessage('unauthorized'), /مفتاح/u);
  assert.match(failureMessage('invalid_response'), /فاضي|غير مفهوم/u);
  assert.match(failureMessage('bad_request'), /أقصر/u);
  const all = new Set(['app_limit', 'rate_limit', 'timeout', 'unauthorized', 'invalid_response', 'bad_request', 'weird'].map((k) => failureMessage(k, 30)));
  assert.equal(all.size, 7, 'every situation has its own message');
});

// ------------------------------------------------------------------ glossary (data-driven English <-> Arabic bridge)
test('glossary rows bridge both ways from data: Arabic slang -> wiki/English terms, English terms -> Arabic wiki terms', () => {
  const entries = parseGlossary('| عامية | مصطلح الويكي | English |\n|---|---|---|\n| نقاط المهارات | نقاط المهارة | skill points |\n');
  assert.ok(entries.some((e) => e.expansion.includes('skill points')), 'Arabic trigger expands to English');
  const english = entries.find((e) => e.triggers.some((t) => t.includes('skill')));
  assert.ok(english, 'English trigger exists');
  assert.match(english!.expansion, /المهارة/u, 'English trigger expands to the Arabic wiki term');
});
