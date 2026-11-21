import { FailoverProvider } from './failover.js';
import { FREE_CHAT_MODELS, FREE_EMBEDDING_MODELS, assertFreeChatModel, assertFreeEmbeddingModel } from './free-models.js';
import type { FetchLike } from './http.js';
import { NeuronBudget, type ProviderLimits } from './limiter.js';
import { OpenAiCompatibleEmbedder, OpenAiCompatibleProvider, type OpenAiCompatibleConfig } from './openai-compatible.js';
import type { Embedder, LlmProvider } from './types.js';

export type EnvLike = Record<string, string | undefined>;

interface Preset {
  /** May contain braced upper-case placeholders that are filled from the environment (Cloudflare needs the account id). */
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
  /** Free-tier ceilings published by the provider at the time of writing; override with LLM_LIMITS_<NAME>. */
  limits: ProviderLimits;
  extraBody?: (model: string, env: EnvLike) => Record<string, unknown>;
  /** Error text meaning "the free quota for the day is used up" (turned into a long cool-down, not repeated retries). */
  dailyQuota?: OpenAiCompatibleConfig['dailyQuota'];
  embedding?: { model: string; rpm: number };
}

/**
 * Provider presets. All are OpenAI-compatible endpoints and ALL are free-tier only; which models may be used is decided by
 * the allowlist in free-models.ts. Free-tier limits change — they are defaults for the local limiter only (so we back off
 * before the provider has to reject us) and can be overridden with `LLM_LIMITS_<PROVIDER>=rpm:30,tpm:8000,rpd:1000,tpd:200000`.
 *
 * Mistral and Gemini were removed from this version: their free status was not re-verified, and unverified providers must stay disabled.
 */
export const PROVIDER_PRESETS: Record<string, Preset> = {
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', defaultModel: 'qwen/qwen3.8-27b',
    // Groq limits are per MODEL, so every Groq model in the chain gets its own counters.
    limits: { rpm: 30, tpm: 8_000, rpd: 1_000, tpd: 200_000 },
    extraBody: (model, env) => {
      const effort = env.GROQ_REASONING_EFFORT?.trim();
      if (/gpt-oss/iu.test(model)) return { include_reasoning: false, reasoning_effort: effort || 'low' };
      if (/qwen/iu.test(model)) return { reasoning_format: 'hidden', ...(effort ? { reasoning_effort: effort } : {}) };
      return {};
    },
  },
  cloudflare: {
    // Workers AI Free plan: 10,000 neurons/day at no charge; when used up, calls FAIL (they are not billed) until 00:00 UTC.
    // Only models that the pricing page does not flag as needing a paid billing method are allowlisted.
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1', keyEnv: 'CLOUDFLARE_API_TOKEN', defaultModel: '@cf/openai/gpt-oss-120b',
    limits: { rpm: 100 },
    extraBody: (_model, env) => {
      const effort = (env.CLOUDFLARE_REASONING_EFFORT?.trim() || 'low').toLowerCase();
      return effort === 'off' ? {} : { reasoning_effort: effort };
    },
    dailyQuota: { pattern: /neurons|free allocation|daily (free )?(limit|quota|allocation)|\b4006\b/iu },
    embedding: { model: '@cf/baai/bge-m3', rpm: 60 },
  },
  openrouter: {
    // Without purchased credits free models allow 20 requests/minute and 50 requests/DAY in total. Only explicit ":free" models are allowed.
    baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', defaultModel: 'google/gemma-4-26b-a4b-it:free',
    limits: { rpm: 18, rpd: 45 },
    dailyQuota: { pattern: /free-models-per-day|per.?day|daily/iu, cooldownSeconds: () => 3_600 },
  },
};

/**
 * The default free chain, built from the API keys that are actually present. A provider without its key(s) is simply not in the chain.
 * Order: Groq's main model, then Cloudflare (no per-minute token ceiling), then Groq's second model (separate quota bucket), then OpenRouter
 * (only 50 requests/day, so last). Used when LLM_PRIMARY is unset, and appended to an explicit chain by `LLM_BACKUP=auto`.
 */
export function defaultChain(env: EnvLike): ProviderSpec[] {
  const has = (name: string) => Boolean(env[PROVIDER_PRESETS[name]!.keyEnv]?.trim()) && (name !== 'cloudflare' || Boolean(env.CLOUDFLARE_ACCOUNT_ID?.trim()));
  const chain: ProviderSpec[] = [];
  const groqMain = env.GROQ_MODEL?.trim() || PROVIDER_PRESETS.groq!.defaultModel;
  if (has('groq')) chain.push({ provider: 'groq', model: groqMain });
  if (has('cloudflare')) chain.push({ provider: 'cloudflare', model: PROVIDER_PRESETS.cloudflare!.defaultModel });
  if (has('groq') && groqMain !== 'openai/gpt-oss-120b') chain.push({ provider: 'groq', model: 'openai/gpt-oss-120b' });
  if (has('openrouter')) chain.push({ provider: 'openrouter', model: PROVIDER_PRESETS.openrouter!.defaultModel });
  return chain;
}

/** Workers AI chat models and the embedder draw from ONE account-wide daily allowance, so they share one local budget. */
const sharedBudgets = new Map<string, NeuronBudget>();
export function resetSharedBudgets(): void { sharedBudgets.clear(); }
function cloudflareBudget(env: EnvLike): NeuronBudget {
  let budget = sharedBudgets.get('cloudflare');
  if (!budget) {
    const requested = Number(env.CLOUDFLARE_DAILY_NEURON_BUDGET);
    // Never above the real free allowance (10,000); the default keeps a 10% margin.
    budget = new NeuronBudget(Number.isFinite(requested) && requested > 0 ? Math.min(requested, 10_000) : 9_000);
    sharedBudgets.set('cloudflare', budget);
  }
  return budget;
}

/** Replace braced placeholders with environment values; fails clearly when one is missing. */
export function resolveBaseUrl(template: string, env: EnvLike): string {
  return template.replace(/\{([A-Z0-9_]+)\}/gu, (_match, name: string) => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return encodeURIComponent(value);
  });
}

export interface ProviderSpec { provider: string; model: string; }

/** `groq:qwen/qwen3.8-27b` -> { provider: 'groq', model: 'qwen/qwen3.8-27b' }; a bare provider name uses its default model. */
export function parseProviderSpec(spec: string): ProviderSpec {
  const text = spec.trim();
  const index = text.indexOf(':');
  const provider = (index === -1 ? text : text.slice(0, index)).toLowerCase();
  if (!PROVIDER_PRESETS[provider]) throw new Error(`Unknown LLM provider "${provider}". Supported: ${Object.keys(PROVIDER_PRESETS).join(', ')}`);
  const model = index === -1 ? PROVIDER_PRESETS[provider]!.defaultModel : text.slice(index + 1).trim();
  if (!model) throw new Error(`Missing model name in "${spec}"`);
  return { provider, model };
}

export function parseLimits(text: string | undefined): ProviderLimits | undefined {
  if (!text?.trim()) return undefined;
  const limits: ProviderLimits = {};
  for (const part of text.split(',')) {
    const [key, value] = part.split(/[:=]/u).map((item) => item.trim());
    const number = Number(value);
    if (!key || !Number.isFinite(number) || number <= 0) throw new Error(`Invalid limit "${part}"`);
    if (key === 'rpm' || key === 'tpm' || key === 'rpd' || key === 'tpd') limits[key] = number;
    else throw new Error(`Unknown limit key "${key}"`);
  }
  return limits;
}

export function buildProvider(spec: ProviderSpec, env: EnvLike, fetcher?: FetchLike): LlmProvider {
  const preset = PROVIDER_PRESETS[spec.provider]!;
  const apiKey = env[preset.keyEnv]?.trim();
  if (!apiKey) throw new Error(`${preset.keyEnv} is required to use ${spec.provider}`);
  // Hard safety rail: only explicitly approved free models can be used. Unknown or paid IDs are rejected here, before any request.
  assertFreeChatModel(spec.provider, spec.model);
  const limits = parseLimits(env[`LLM_LIMITS_${spec.provider.toUpperCase()}`]) ?? preset.limits;
  const neurons = FREE_CHAT_MODELS[spec.provider]?.[spec.model]?.neurons;
  return new OpenAiCompatibleProvider({
    name: spec.provider, baseUrl: resolveBaseUrl(preset.baseUrl, env), apiKey, model: spec.model, limits,
    extraBody: preset.extraBody?.(spec.model, env) ?? {}, timeoutMs: Number(env.LLM_TIMEOUT_MS) || 45_000,
    ...(preset.dailyQuota ? { dailyQuota: preset.dailyQuota } : {}),
    ...(neurons && spec.provider === 'cloudflare' ? { budget: { tracker: cloudflareBudget(env), inputPerMillion: neurons.input, outputPerMillion: neurons.output } } : {}),
  }, fetcher);
}

/** Primary first, then backups in the listed order. Missing keys for *backups* are skipped with a warning; a missing primary key is an error. */
export function buildLlm(env: EnvLike, fetcher?: FetchLike, warn: (message: string) => void = () => undefined): { llm: LlmProvider; specs: ProviderSpec[] } {
  const rawPrimary = env.LLM_PRIMARY?.trim() ?? '';
  const backupText = env.LLM_BACKUP ?? '';
  let primary: ProviderSpec;
  let backups: ProviderSpec[] = [];
  if (!rawPrimary) {
    const chain = defaultChain(env);
    if (!chain.length) throw new Error('No language model is configured. Set LLM_PRIMARY (for example "groq:qwen/qwen3.8-27b") and the matching API key (GROQ_API_KEY), or just add API keys: with LLM_PRIMARY unset the bot builds a free chain from every provider that has a key.');
    primary = chain[0]!;
    backups = chain.slice(1);
    warn(`LLM_PRIMARY is not set; using the default free chain built from the API keys present: ${chain.map((spec) => `${spec.provider}:${spec.model}`).join(' -> ')}. Set LLM_PRIMARY/LLM_BACKUP to choose explicitly.`);
  } else {
    primary = parseProviderSpec(rawPrimary);
    const items = backupText.split(',').map((item) => item.trim()).filter(Boolean);
    backups = items.filter((item) => item.toLowerCase() !== 'auto').map(parseProviderSpec);
    if (items.some((item) => item.toLowerCase() === 'auto')) {
      for (const spec of defaultChain(env)) if (![primary, ...backups].some((known) => known.provider === spec.provider && known.model === spec.model)) backups.push(spec);
    }
  }
  const providers: LlmProvider[] = [buildProvider(primary, env, fetcher)];
  const specs: ProviderSpec[] = [primary];
  for (const backup of backups) {
    assertFreeChatModel(backup.provider, backup.model); // a paid/unknown backup is a configuration error, never a silent skip
    try { providers.push(buildProvider(backup, env, fetcher)); specs.push(backup); }
    catch (error) { warn(`Backup provider ${backup.provider}:${backup.model} skipped: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { llm: providers.length === 1 ? providers[0]! : new FailoverProvider(providers, { maxWaitMs: (Number(env.LLM_MAX_WAIT_SECONDS) || 45) * 1000 }), specs };
}

/** Embedding provider selection. Only Cloudflare Workers AI (bge-m3) is approved. `none` disables embeddings (keyword search only). */
export function buildEmbedder(env: EnvLike, fetcher?: FetchLike): Embedder | undefined {
  const choice = (env.EMBEDDING_PROVIDER?.trim().toLowerCase() || 'auto');
  if (choice === 'none' || choice === 'off') return undefined;
  const candidates = choice === 'auto' ? ['cloudflare'] : [choice];
  for (const name of candidates) {
    const preset = PROVIDER_PRESETS[name];
    if (!preset?.embedding) throw new Error(`Provider "${name}" has no approved free embedding model. Supported: ${Object.keys(FREE_EMBEDDING_MODELS).join(', ')}, or "none".`);
    const apiKey = env[preset.keyEnv]?.trim();
    if (!apiKey) { if (choice !== 'auto') throw new Error(`${preset.keyEnv} is required for EMBEDDING_PROVIDER=${name}`); continue; }
    let baseUrl: string;
    try { baseUrl = resolveBaseUrl(preset.baseUrl, env); }
    catch (error) { if (choice !== 'auto') throw error; continue; }
    const model = env.EMBEDDING_MODEL?.trim() || preset.embedding.model;
    assertFreeEmbeddingModel(name, model);
    const price = FREE_EMBEDDING_MODELS[name]![model]!.neuronsPerMillionTokens;
    return new OpenAiCompatibleEmbedder({ name, baseUrl, apiKey, model, rpm: preset.embedding.rpm, budget: { tracker: cloudflareBudget(env), neuronsPerMillionTokens: price }, ...(preset.dailyQuota ? { dailyQuota: preset.dailyQuota } : {}) }, fetcher);
  }
  return undefined;
}
