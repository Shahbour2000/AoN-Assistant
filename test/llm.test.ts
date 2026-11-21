import assert from 'node:assert/strict';
import test from 'node:test';
import { FailoverProvider } from '../src/llm/failover.js';
import { LocalLimiter } from '../src/llm/limiter.js';
import { OpenAiCompatibleEmbedder, OpenAiCompatibleProvider, stripReasoning } from '../src/llm/openai-compatible.js';
import { buildEmbedder, buildLlm, parseLimits, parseProviderSpec } from '../src/llm/presets.js';
import { LlmError, type LlmProvider } from '../src/llm/types.js';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const config = { name: 'mistral', baseUrl: 'https://example.test/v1', apiKey: 'SECRET-KEY', model: 'm1' };

test('provider sends OpenAI-style request with tools and parses content, tool calls and usage', async () => {
  let seen: { url: string; body: any; auth: string } | undefined;
  const fetcher = async (url: any, init: any) => { seen = { url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization }; return json({ choices: [{ message: { content: null, tool_calls: [{ id: 'a1', function: { name: 'search_knowledge', arguments: '{"queries":["x"]}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } }); };
  const provider = new OpenAiCompatibleProvider({ ...config, extraBody: { reasoning_format: 'hidden' } }, fetcher as never);
  const response = await provider.chat({ messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }], tools: [{ name: 'search_knowledge', description: 'd', parameters: { type: 'object' } }] });
  assert.equal(seen!.url, 'https://example.test/v1/chat/completions');
  assert.equal(seen!.auth, 'Bearer SECRET-KEY');
  assert.equal(seen!.body.tools[0].function.name, 'search_knowledge');
  assert.equal(seen!.body.tool_choice, 'auto');
  assert.equal(seen!.body.reasoning_format, 'hidden');
  assert.equal(response.toolCalls[0]?.name, 'search_knowledge');
  assert.equal(response.usage?.promptTokens, 10);
});

test('assistant tool-call history and tool results are serialised in wire format', async () => {
  let body: any;
  const fetcher = async (_u: any, init: any) => { body = JSON.parse(init.body); return json({ choices: [{ message: { content: 'ok' } }] }); };
  await new OpenAiCompatibleProvider(config, fetcher as never).chat({ messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: null, toolCalls: [{ id: 't1', name: 'calculate', arguments: '{"expression":"1+1"}' }] }, { role: 'tool', toolCallId: 't1', content: '{"status":"ok"}' }] });
  assert.equal(body.messages[1].tool_calls[0].function.name, 'calculate');
  assert.equal(body.messages[2].tool_call_id, 't1');
});

test('leaked <think> blocks are stripped from answers', () => {
  assert.equal(stripReasoning('<think>hmm</think>\nمرحبا'), 'مرحبا');
  assert.equal(stripReasoning('plan...</think>Answer'), 'Answer');
});

test('HTTP failures map to typed errors; secrets never appear in messages', async () => {
  const mk = (status: number, headers: Record<string, string> = {}) => new OpenAiCompatibleProvider({ ...config, retries: 0 }, (async () => json({ error: { message: 'bad Bearer SECRET-KEY' } }, status, headers)) as never);
  const kinds: Array<[number, string]> = [[401, 'unauthorized'], [403, 'forbidden'], [429, 'rate_limit'], [500, 'unavailable'], [400, 'bad_request']];
  for (const [status, kind] of kinds) {
    await assert.rejects(() => mk(status).chat({ messages: [{ role: 'user', content: 'x' }] }), (error: unknown) => error instanceof LlmError && error.kind === kind && !error.message.includes('SECRET-KEY'));
  }
  const limited = await mk(429, { 'retry-after': '7' }).chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e as LlmError);
  assert.equal((limited as LlmError).retryAfterSeconds, 7);
});

test('network failure, timeout and invalid JSON are distinguished', async () => {
  const run = (fetcher: unknown) => new OpenAiCompatibleProvider({ ...config, retries: 0 }, fetcher as never).chat({ messages: [{ role: 'user', content: 'x' }] }).catch((e) => e as LlmError);
  assert.equal(((await run(async () => { throw new TypeError('fetch failed'); })) as LlmError).kind, 'network');
  assert.equal(((await run(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; })) as LlmError).kind, 'timeout');
  assert.equal(((await run(async () => new Response('<html>', { status: 200 }))) as LlmError).kind, 'invalid_response');
  assert.equal(((await run(async () => json({ choices: [] }))) as LlmError).kind, 'invalid_response');
});

test('a short 429 is retried once, 5xx is retried once, then it surfaces', async () => {
  let calls = 0;
  const fetcher = async () => (++calls === 1 ? json({ error: 'slow' }, 429, { 'retry-after': '1' }) : json({ choices: [{ message: { content: 'ok' } }] }));
  const provider = new OpenAiCompatibleProvider(config, fetcher as never, undefined, async () => undefined);
  assert.equal((await provider.chat({ messages: [{ role: 'user', content: 'x' }] })).content, 'ok');
  assert.equal(calls, 2);
});

test('failover uses the backup only for failover-eligible errors and remembers cooldowns', async () => {
  const failing: LlmProvider = { id: 'a', chat: async () => { throw new LlmError('rate_limit', 'limited', { provider: 'a', retryAfterSeconds: 30 }); } };
  let backupCalls = 0;
  const backup: LlmProvider = { id: 'b', chat: async () => { backupCalls++; return { content: 'from b', toolCalls: [], provider: 'b', model: 'x' }; } };
  let primaryCalls = 0;
  const primary: LlmProvider = { id: 'a', chat: async (r) => { primaryCalls++; return failing.chat(r); } };
  const chain = new FailoverProvider([primary, backup]);
  assert.equal((await chain.chat({ messages: [] })).content, 'from b');
  assert.equal((await chain.chat({ messages: [] })).content, 'from b');
  assert.equal(primaryCalls, 1, 'primary is skipped while cooling down');
  const allFail = new FailoverProvider([failing, { id: 'c', chat: async () => { throw new LlmError('timeout', 't', { provider: 'c' }); } }]);
  await assert.rejects(() => allFail.chat({ messages: [] }), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit');
  assert.equal(backupCalls, 2);
});

test('local limiter enforces rpm/tpm windows and fails fast when the wait is too long', async () => {
  let now = 0;
  const limiter = new LocalLimiter({ rpm: 2, tpm: 1000 }, () => now, async (ms) => { now += ms; }, 5000);
  await limiter.acquire(100, 'p'); await limiter.acquire(100, 'p');
  await assert.rejects(() => limiter.acquire(100, 'p'), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit' && (e.retryAfterSeconds ?? 0) > 0);
  now += 61_000;
  await limiter.acquire(100, 'p');
  await assert.rejects(() => limiter.acquire(5000, 'p'), (e: unknown) => e instanceof LlmError && e.kind === 'rate_limit');
});

test('presets: spec parsing, limits parsing and embedder selection', () => {
  assert.deepEqual(parseProviderSpec('groq:qwen/qwen3.8-27b'), { provider: 'groq', model: 'qwen/qwen3.8-27b' });
  assert.deepEqual(parseProviderSpec('openrouter:google/gemma-4-26b-a4b-it:free'), { provider: 'openrouter', model: 'google/gemma-4-26b-a4b-it:free' });
  assert.deepEqual(parseProviderSpec('cloudflare'), { provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' });
  assert.throws(() => parseProviderSpec('nope:model'), /Unknown LLM provider/);
  assert.deepEqual(parseLimits('rpm:30,tpm:8000'), { rpm: 30, tpm: 8000 });
  assert.throws(() => parseLimits('rpm:abc'), /Invalid limit/);
  assert.equal(buildEmbedder({}), undefined);
  assert.equal(buildEmbedder({ CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc' })?.id, 'cloudflare:@cf/baai/bge-m3');
  assert.equal(buildEmbedder({ CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc', EMBEDDING_PROVIDER: 'none' }), undefined);
  assert.throws(() => buildEmbedder({ EMBEDDING_PROVIDER: 'groq', GROQ_API_KEY: 'k' }), /no approved free embedding/);
});

test('embedder returns vectors in index order and rejects malformed responses', async () => {
  const ok = new OpenAiCompatibleEmbedder({ name: 'm', baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'e' }, (async () => json({ data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }] })) as never);
  assert.deepEqual(await ok.embed(['a', 'b'], 'document'), [[1, 0], [0, 1]]);
  const bad = new OpenAiCompatibleEmbedder({ name: 'm', baseUrl: 'https://e.test/v1', apiKey: 'k', model: 'e' }, (async () => json({ data: [] })) as never);
  await assert.rejects(() => bad.embed(['a'], 'query'), (e: unknown) => e instanceof LlmError && e.kind === 'invalid_response');
});

test('provider selection: explicit primary wins; blank LLM_PRIMARY + LLM_BACKUP builds the full automatic chain from the available keys', () => {
  const warnings: string[] = [];
  const warn = (message: string) => { warnings.push(message); };
  const cf = { CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' };
  assert.deepEqual(buildLlm({ LLM_PRIMARY: 'cloudflare:@cf/openai/gpt-oss-120b', ...cf, GROQ_API_KEY: 'g' }, undefined, warn).specs, [{ provider: 'cloudflare', model: '@cf/openai/gpt-oss-120b' }]);
  assert.equal(warnings.length, 0);
  // Full chain: Groq main -> Cloudflare chat -> Groq secondary -> OpenRouter free (the user's real .env shape: LLM_PRIMARY= and LLM_BACKUP= blank).
  const all = buildLlm({ LLM_PRIMARY: '', LLM_BACKUP: '', GROQ_API_KEY: 'g', GROQ_MODEL: 'qwen/qwen3.8-27b', OPENROUTER_API_KEY: 'o', ...cf }, undefined, warn);
  assert.deepEqual(all.specs.map((spec) => `${spec.provider}:${spec.model}`), ['groq:qwen/qwen3.8-27b', 'cloudflare:@cf/openai/gpt-oss-120b', 'groq:openai/gpt-oss-120b', 'openrouter:google/gemma-4-26b-a4b-it:free']);
  assert.match(warnings.at(-1) ?? '', /building the chain automatically/u);
  // The secondary Groq model is never the same as the main one.
  assert.equal(buildLlm({ GROQ_API_KEY: 'g', GROQ_MODEL: 'openai/gpt-oss-120b' }, undefined, warn).specs[1]?.model, 'qwen/qwen3.8-27b');
  // Providers without credentials are left out: Cloudflare needs token AND account id; OpenRouter needs its key.
  assert.deepEqual(buildLlm({ GROQ_API_KEY: 'g', CLOUDFLARE_API_TOKEN: 't' }, undefined, warn).specs.map((spec) => spec.provider), ['groq', 'groq']);
  assert.deepEqual(buildLlm({ CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }, undefined, warn).specs.map((spec) => spec.provider), ['cloudflare']);
  assert.deepEqual(buildLlm({ OPENROUTER_API_KEY: 'o' }, undefined, warn).specs.map((spec) => spec.provider), ['openrouter']);
  // An unapproved GROQ_MODEL is a startup error, never silently replaced.
  assert.throws(() => buildLlm({ GROQ_API_KEY: 'g', GROQ_MODEL: 'some/paid-model' }), /not on the approved free-model list/u);
  assert.throws(() => buildLlm({}), /No language model is configured/u);
  assert.throws(() => buildLlm({ LLM_PRIMARY: 'cloudflare' }), /CLOUDFLARE_API_TOKEN is required/u);
  assert.throws(() => buildLlm({ LLM_PRIMARY: 'cloudflare', CLOUDFLARE_API_TOKEN: 't' }), /CLOUDFLARE_ACCOUNT_ID is required/u);
  assert.throws(() => buildLlm({ LLM_PRIMARY: 'openai:gpt-4o', GROQ_API_KEY: 'k' }), /Unknown LLM provider/u);
  const withBackups = buildLlm({ LLM_PRIMARY: 'groq', LLM_BACKUP: 'openrouter, cloudflare', GROQ_API_KEY: 'g', ...cf }, undefined, warn);
  assert.deepEqual(withBackups.specs.map((spec) => spec.provider), ['groq', 'cloudflare']);
  assert.ok(warnings.some((message) => /openrouter.*skipped/u.test(message)), 'a backup without a key is skipped with a warning');
});

test('failover scenario: Groq answers, then its local token limit is hit, the next question is served by Cloudflare with no waiting, later questions skip Groq', async () => {
  const calls = { groq: 0, cloudflare: 0 };
  const ok = (text: string, prompt: number) => json({ choices: [{ message: { content: text } }], usage: { prompt_tokens: prompt, completion_tokens: 50 } });
  const fetcher = (async (url: any) => {
    const target = String(url);
    if (target.includes('api.groq.com')) { calls.groq++; return ok('جواب من Groq', 5000); }
    if (target.includes('api.cloudflare.com')) { calls.cloudflare++; return ok('جواب من Cloudflare', 5000); }
    throw new Error(`unexpected URL ${target}`);
  }) as never;
  const { llm } = buildLlm({ GROQ_API_KEY: 'g', GROQ_MODEL: 'qwen/qwen3.8-27b', CLOUDFLARE_API_TOKEN: 't', CLOUDFLARE_ACCOUNT_ID: 'a' }, fetcher);
  const bigQuestion = { messages: [{ role: 'user' as const, content: 'x'.repeat(16_000) }], maxTokens: 400 }; // ~5,000 estimated prompt tokens, like a wiki question
  const started = Date.now();
  assert.equal((await llm.chat(bigQuestion)).content, 'جواب من Groq');
  const second = await llm.chat(bigQuestion);     // Groq's 8,000 tokens/minute is exhausted locally -> must fail over immediately
  assert.equal(second.provider, 'cloudflare');
  assert.equal(second.content, 'جواب من Cloudflare');
  assert.ok(Date.now() - started < 5_000, 'failover must not make the player wait for the Groq limiter');
  assert.deepEqual(calls, { groq: 1, cloudflare: 1 }, 'the locally rejected request never reached Groq');
  await llm.chat(bigQuestion);                    // Groq is cooling down: goes straight to Cloudflare
  assert.deepEqual(calls, { groq: 1, cloudflare: 2 });
});

test('with a single provider the local limiter may still wait (nothing to fail over to)', async () => {
  const { llm } = buildLlm({ GROQ_API_KEY: 'g', LLM_PRIMARY: 'groq:qwen/qwen3.8-27b' }, (async () => json({ choices: [{ message: { content: 'ok' } }] })) as never);
  assert.equal((await llm.chat({ messages: [{ role: 'user', content: 'hi' }] })).content, 'ok');
});

test('limit overrides accept both "rpm:30" and "rpm=30" and reject unknown keys', () => {
  assert.deepEqual(parseLimits('rpm:30,tpm=8000'), { rpm: 30, tpm: 8000 });
  assert.throws(() => parseLimits('rps:3'), /Unknown limit key/u);
});

test('embedder selection: Cloudflare only, none disables, explicit missing key is an error', () => {
  assert.match(buildEmbedder({ CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'a' })!.id, /^cloudflare:/u);
  assert.equal(buildEmbedder({ CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'a', EMBEDDING_PROVIDER: 'none' }), undefined);
  assert.equal(buildEmbedder({}), undefined);
  assert.throws(() => buildEmbedder({ EMBEDDING_PROVIDER: 'cloudflare' }), /CLOUDFLARE_API_TOKEN is required/u);
  assert.throws(() => buildEmbedder({ CLOUDFLARE_API_TOKEN: 'k', CLOUDFLARE_ACCOUNT_ID: 'a', EMBEDDING_MODEL: '@cf/some/paid-embedder' }), /not on the approved free list/u);
});
