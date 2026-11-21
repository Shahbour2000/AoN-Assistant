import { FailoverProvider } from './failover.js';
import { FREE_CHAT_MODELS, FREE_EMBEDDING_MODELS, assertFreeChatModel, assertFreeEmbeddingModel } from './free-models.js';
import type { FetchLike } from './http.js';
import { NeuronBudget, type ProviderLimits } from './limiter.js';
import { OpenAiCompatibleEmbedder, OpenAiCompatibleProvider, type OpenAiCompatibleConfig } from './openai-compatible.js';
import type { Embedder, LlmProvider } from './types.js';

export type EnvLike = Record<string, string | undefined>;

interface Preset {
  /** May contain `{VAR}` placeholders that are filled from the environment (Cloudflare needs the account id). */
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

/** Order used only when LLM_PRIMARY is unset. */
const AUTO_PRIMARY_ORDER = ['groq', 'cloudflare', 'openrouter'];

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

/** Replace `{VAR}` placeholders with environment values; fails clearly when one is missing. */
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

export function buildProvider(spec: ProviderSpec, env: EnvLike, fetcher?: FetchLike, limiterMaxWaitMs?: number): LlmProvider {
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
    ...(limiterMaxWaitMs === undefined ? {} : { limiterMaxWaitMs }),
    ...(preset.dailyQuota ? { dailyQuota: preset.dailyQuota } : {}),
    ...(neurons && spec.provider === 'cloudflare' ? { budget: { tracker: cloudflareBudget(env), inputPerMillion: neurons.input, outputPerMillion: neurons.output } } : {}),
  }, fetcher);
}

/** Groq models tried as the "secondary" Groq entry of the automatic chain (Groq limits are per model, so this is a separate allowance). */
const GROQ_SECONDARY_CANDIDATES = ['openai/gpt-oss-120b', 'qwen/qwen3.8-27b'];

/**
 * Chain used when BOTH LLM_PRIMARY and LLM_BACKUP are blank. Every provider whose credentials are present is included, in this order:
 *   1. Groq main model (GROQ_MODEL, or the default)   2. Cloudflare Workers AI chat   3. Groq secondary model   4. OpenRouter free model
 * Cloudflare needs BOTH the API token and the account id. OpenRouter is last because it only allows 50 requests/day without purchased credits.
 * A provider without credentials is simply not in the chain.
 */
export function autoChainSpecs(env: EnvLike): ProviderSpec[] {
  const has = (name: string) => Boolean(env[name]?.trim());
  const specs: ProviderSpec[] = [];
  let groqMain: string | undefined;
  if (has('GROQ_API_KEY')) {
    groqMain = env.GROQ_MODEL?.trim() || PROVIDER_PRESETS.groq!.defaultModel;
    specs.push({ provider: 'groq', model: groqMain });
  }
  if (has('CLOUDFLARE_API_TOKEN') && has('CLOUDFLARE_ACCOUNT_ID')) specs.push({ provider: 'cloudflare', model: PROVIDER_PRESETS.cloudflare!.defaultModel });
  if (groqMain) {
    const secondary = GROQ_SECONDARY_CANDIDATES.find((model) => model !== groqMain);
    if (secondary) specs.push({ provider: 'groq', model: secondary });
  }
  if (has('OPENROUTER_API_KEY')) specs.push({ provider: 'openrouter', model: PROVIDER_PRESETS.openrouter!.defaultModel });
  return specs;
}

/** The exact ordered list of provider:model entries the bot will use for this environment (also used by `npm run check:providers`). */
export function resolveChainSpecs(env: EnvLike, warn: (message: string) => void = () => undefined): ProviderSpec[] {
  const rawPrimary = env.LLM_PRIMARY?.trim() ?? '';
  const rawBackup = (env.LLM_BACKUP ?? '').trim();
  if (!rawPrimary && !rawBackup) {
    const specs = autoChainSpecs(env);
    if (!specs.length) throw new Error('No language model is configured. Set GROQ_API_KEY (or CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID, or OPENROUTER_API_KEY), or set LLM_PRIMARY explicitly (for example "groq:qwen/qwen3.8-27b").');
    warn(`LLM_PRIMARY and LLM_BACKUP are blank; building the chain automatically from the available keys: ${specs.map((spec) => `${spec.provider}:${spec.model}`).join(' -> ')}`);
    for (const spec of specs) assertFreeChatModel(spec.provider, spec.model);
    return specs;
  }
  let primaryText = rawPrimary;
  if (!primaryText) {
    // Only backups were given: the first provider that has a key becomes the primary.
    const auto = AUTO_PRIMARY_ORDER.find((name) => env[PROVIDER_PRESETS[name]!.keyEnv]?.trim());
    if (!auto) throw new Error('No language model is configured. Set LLM_PRIMARY (for example "groq:qwen/qwen3.8-27b") and the matching API key (GROQ_API_KEY).');
    primaryText = auto === 'groq' && env.GROQ_MODEL?.trim() ? `groq:${env.GROQ_MODEL.trim()}` : auto;
    warn(`LLM_PRIMARY is not set; using "${primaryText}" because its API key is present. Set LLM_PRIMARY explicitly to choose the model.`);
  }
  const primary = parseProviderSpec(primaryText);
  const backups = rawBackup.split(',').map((item) => item.trim()).filter(Boolean).map(parseProviderSpec);
  for (const backup of backups) assertFreeChatModel(backup.provider, backup.model); // a paid/unknown backup is a configuration error, never a silent skip
  return [primary, ...backups];
}

/**
 * Builds the failover chain. In a multi-provider chain every provider except the last gives up quickly on its own local limiter
 * (1.5 s) so the NEXT provider answers immediately instead of the player waiting up to 25 s for the first one to free up.
 * A missing key for the primary is an error; backups/auto entries that cannot be built are skipped with a warning.
 */
export function buildLlm(env: EnvLike, fetcher?: FetchLike, warn: (message: string) => void = () => undefined): { llm: LlmProvider; specs: ProviderSpec[] } {
  const wanted = resolveChainSpecs(env, warn);
  const auto = !(env.LLM_PRIMARY?.trim()) && !(env.LLM_BACKUP ?? '').trim();
  const specs: ProviderSpec[] = [];
  const providers: LlmProvider[] = [];
  const FAST_FAIL_MS = 1_500;
  wanted.forEach((spec, index) => {
    const isLast = index === wanted.length - 1;
    const wait = wanted.length > 1 && !isLast ? FAST_FAIL_MS : undefined;
    try { providers.push(buildProvider(spec, env, fetcher, wait)); specs.push(spec); }
    catch (error) {
      if (index === 0 && !auto) throw error; // explicit primary must work
      warn(`Provider ${spec.provider}:${spec.model} skipped: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
  if (!providers.length) throw new Error('No usable language model provider could be built from the configured keys.');
  return { llm: providers.length === 1 ? providers[0]! : new FailoverProvider(providers), specs };
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
