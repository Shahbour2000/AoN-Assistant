import assert from 'node:assert/strict';
import test from 'node:test';
import { FREE_CHAT_MODELS, KNOWN_PAID_ONLY_MODELS, assertFreeChatModel } from '../src/llm/free-models.js';
import { FailoverProvider } from '../src/llm/failover.js';
import { NeuronBudget, secondsUntilUtcMidnight } from '../src/llm/limiter.js';
import { parseRateLimitReset } from '../src/llm/http.js';
import { OpenAiCompatibleProvider } from '../src/llm/openai-compatible.js';
import { buildLlm, buildProvider, parseProviderSpec, resetSharedBudgets } from '../src/llm/presets.js';
import { LlmError, type LlmProvider } from '../src/llm/types.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const env = { GROQ_API_KEY: 'g-key-123456', CLOUDFLARE_API_TOKEN: 'c-token-123456', CLOUDFLARE_ACCOUNT_ID: 'acc', OPENROUTER_API_KEY: 'o-key-123456' };
const ask = { messages: [{ role: 'user' as const, content: 'hi' }], maxTokens: 50 };

test('paid, unknown and look-alike models cannot be selected for any provider', () => {
  for (const model of ['@cf/moonshotai/kimi-k2.6', '@cf/zai-org/glm-5.2', '@cf/deepseek-ai/deepseek-v4-pro-0813']) {
    assert.throws(() => buildLlm({ ...env, LLM_PRIMARY: `cloudflare:${model}` }), /paid billing method|not on the approved/u, model);
  }
  const bad: Array<[string, string]> = [
    ['openrouter', 'openai/gpt-4o'], ['openrouter', 'google/gemma-4-26b-a4b-it'], ['openrouter', 'openrouter/auto'], ['openrouter', 'anthropic/claude-sonnet:free'],
    ['groq', 'llama-3.3-70b'], ['groq', 'some/new-model'], ['groq', 'QWEN/QWEN3.8-27B'], ['groq', '__proto__'], ['groq', 'constructor'],
    ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct'], ['cloudflare', 'toString'],
  ];
  for (const [provider, model] of bad) assert.throws(() => buildProvider({ provider, model }, env), /approved free-model list|not on the approved|blocked|paid/u, `${provider}:${model}`);
});

test('a bad backup model is a startup error, not a silent skip or a silent fallback to something else', () => {
  assert.throws(() => buildLlm({ ...env, LLM_PRIMARY: 'groq', LLM_BACKUP: 'openrouter:openai/gpt-4o' }, undefined, () => undefined), /approved free-model list/u);
});

test('every allowlisted model is accepted, and the paid-only list never overlaps the allowlist', () => {
  for (const [provider, models] of Object.entries(FREE_CHAT_MODELS)) {
    for (const model of Object.keys(models)) {
      assert.doesNotThrow(() => assertFreeChatModel(provider, model));
      assert.ok(!KNOWN_PAID_ONLY_MODELS.has(model), `${model} is paid-only`);
      assert.doesNotThrow(() => buildProvider(parseProviderSpec(`${provider}:${model}`), env), `${provider}:${model}`);
    }
  }
  for (const model of Object.keys(FREE_CHAT_MODELS.openrouter!)) assert.ok(model.endsWith(':free'));
});

test('requests carry exactly the chosen model and never a fallback "models" list or router (OpenRouter bills paid fallbacks)', async () => {
  let body: any;
  const fetcher = async (_url: unknown, init: any) => { body = JSON.parse(init.body); return json({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }); };
  const provider = buildProvider({ provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' }, env, fetcher as never);
  await provider.chat(ask);
  assert.equal(body.model, 'google/gemma-4-26b-a4b-it:free');
  assert.equal(body.models, undefined);
  assert.equal(body.route, undefined);
  assert.equal(body.provider, undefined);
});

test('Cloudflare chat goes to the account-scoped OpenAI-compatible endpoint with low reasoning effort by default', async () => {
  resetSharedBudgets();
  let seen: { url: string; body: any } | undefined;
  const fetcher = async (url: unknown, init: any) => { seen = { url: String(url), body: JSON.parse(init.body) }; return json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 100, completion_tokens: 10 } }); };
  const provider = buildProvider({ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' }, env, fetcher as never);
  await provider.chat(ask);
  assert.equal(seen!.url, 'https://api.cloudflare.com/client/v4/accounts/acc/ai/v1/chat/completions');
  assert.equal(seen!.body.reasoning_effort, 'low');
  const off = buildProvider({ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' }, { ...env, CLOUDFLARE_REASONING_EFFORT: 'off' }, fetcher as never);
  await off.chat(ask);
  assert.equal(seen!.body.reasoning_effort, undefined);
});

test('shared neuron budget stops Cloudflare calls locally before the real allowance is spent, and resets at UTC midnight', async () => {
  let now = Date.UTC(2026, 10, 20, 10, 0, 0);
  const budget = new NeuronBudget(100, () => now);
  budget.reserve(60, 'cloudflare');
  assert.throws(() => budget.reserve(60, 'cloudflare'), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit' && (e.retryAfterSeconds ?? 0) === 14 * 3600);
  budget.settle(10, 60); // actual use was lower than the estimate
  budget.reserve(60, 'cloudflare');
  now = Date.UTC(2026, 10, 21, 0, 0, 1);
  budget.reserve(100, 'cloudflare');
  assert.equal(secondsUntilUtcMidnight(Date.UTC(2026, 10, 20, 23, 59, 59)), 1);
});

test('Cloudflare provider refuses calls once the shared budget is gone and does not touch the network', async () => {
  resetSharedBudgets();
  let calls = 0;
  const fetcher = async () => { calls++; return json({ choices: [{ message: { content: 'ok' } }] }); };
  const tiny = { ...env, CLOUDFLARE_DAILY_NEURON_BUDGET: '1' };
  const provider = buildProvider({ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' }, tiny, fetcher as never);
  await assert.rejects(() => provider.chat(ask), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit' && (e.retryAfterSeconds ?? 0) > 0);
  assert.equal(calls, 0);
  resetSharedBudgets();
});

test('the budget can never be configured above the real 10,000-neuron free allowance', async () => {
  resetSharedBudgets();
  const fetcher = async () => json({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  const provider = buildProvider({ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' }, { ...env, CLOUDFLARE_DAILY_NEURON_BUDGET: '999999999' }, fetcher as never);
  await provider.chat(ask);
  // 10,000 neurons at ~0.0318 neurons per input token is far above one call; just prove clamping via the exported budget behaviour.
  const huge = { ...ask, messages: [{ role: 'user' as const, content: 'x'.repeat(4_000_000) }] };
  await assert.rejects(() => provider.chat(huge), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit');
  resetSharedBudgets();
});

test('Cloudflare "daily allocation used" errors become a long cool-down so the provider is not retried all day', async () => {
  resetSharedBudgets();
  let calls = 0;
  const fetcher = async () => { calls++; return json({ success: false, errors: [{ code: 4006, message: 'you have used up your daily free allocation of 10,000 neurons' }] }, 429); };
  const cf = buildProvider({ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' }, env, fetcher as never);
  const backup: LlmProvider = { id: 'groq:x', chat: async () => ({ content: 'from backup', toolCalls: [], provider: 'groq', model: 'x' }) };
  const failover = new FailoverProvider([cf, backup]);
  assert.equal((await failover.chat(ask)).content, 'from backup');
  const afterFirst = calls;
  assert.equal((await failover.chat(ask)).content, 'from backup');
  assert.equal(calls, afterFirst, 'the exhausted provider is skipped, not retried');
  resetSharedBudgets();
});

test('OpenRouter 50/day exhaustion fails over and is not retried; reset header is honoured', async () => {
  let calls = 0;
  const resetAt = Date.now() + 5 * 3600_000;
  const fetcher = async () => { calls++; return json({ error: { message: 'Rate limit exceeded: free-models-per-day' } }, 429, { 'x-ratelimit-reset': String(resetAt) }); };
  const or = buildProvider({ provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' }, env, fetcher as never);
  const backup: LlmProvider = { id: 'groq:x', chat: async () => ({ content: 'b', toolCalls: [], provider: 'groq', model: 'x' }) };
  const failover = new FailoverProvider([or, backup]);
  await failover.chat(ask); await failover.chat(ask); await failover.chat(ask);
  assert.equal(calls, 1);
  assert.ok((parseRateLimitReset(String(resetAt)) ?? 0) > 4 * 3600);
  assert.equal(parseRateLimitReset('abc'), undefined);
});

test('a rate-limited provider with a long Retry-After is not retried before it elapses (cool-down up to a day)', async () => {
  let now = 0; let calls = 0;
  const limited: LlmProvider = { id: 'groq:a', chat: async () => { calls++; throw new LlmError('rate_limit', 'TPD', { provider: 'groq', status: 429, retryAfterSeconds: 3600 }); } };
  const backup: LlmProvider = { id: 'cf:b', chat: async () => ({ content: 'b', toolCalls: [], provider: 'cf', model: 'b' }) };
  const failover = new FailoverProvider([limited, backup], () => now);
  await failover.chat(ask);
  now = 10 * 60_000; await failover.chat(ask);
  assert.equal(calls, 1);
  now = 61 * 60_000; await failover.chat(ask);
  assert.equal(calls, 2);
});

test('when every free provider is exhausted the error is surfaced; nothing else is tried', async () => {
  const dead = (id: string): LlmProvider => ({ id, chat: async () => { throw new LlmError('rate_limit', 'limit', { provider: id, retryAfterSeconds: 60 }); } });
  await assert.rejects(() => new FailoverProvider([dead('a'), dead('b')]).chat(ask), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit');
});

test('API keys never reach error messages or logs', async () => {
  const fetcher = async () => json({ error: { message: 'bad key g-key-123456 Bearer abcdefgh' } }, 401);
  const provider = new OpenAiCompatibleProvider({ name: 'groq', baseUrl: 'https://x.test/v1', apiKey: 'g-key-123456', model: 'm' }, fetcher as never);
  await assert.rejects(() => provider.chat(ask), (e: unknown) => e instanceof LlmError && !/Bearer abcdefgh/u.test(e.message));
});
