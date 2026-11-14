import { FailoverProvider } from './failover.js';
import type { FetchLike } from './http.js';
import type { ProviderLimits } from './limiter.js';
import { OpenAiCompatibleEmbedder, OpenAiCompatibleProvider } from './openai-compatible.js';
import type { Embedder, LlmProvider } from './types.js';

export type EnvLike = Record<string, string | undefined>;

interface Preset {
  baseUrl: string;
  keyEnv: string;
  defaultModel: string;
  /** Free-tier ceilings published by the provider at the time of writing; override with LLM_LIMITS_<NAME>. */
  limits: ProviderLimits;
  extraBody?: (model: string, env: EnvLike) => Record<string, unknown>;
  embedding?: { model: string; rpm: number };
}

/**
 * Provider presets. All of these are OpenAI-compatible endpoints. Free-tier limits change — they are defaults for the
 * local limiter only (so we back off before the provider has to reject us) and can be overridden with
 * `LLM_LIMITS_<PROVIDER>=rpm:30,tpm:8000,rpd:1000,tpd:200000`.
 */
export const PROVIDER_PRESETS: Record<string, Preset> = {
  mistral: {
    baseUrl: 'https://api.mistral.ai/v1', keyEnv: 'MISTRAL_API_KEY', defaultModel: 'mistral-large-latest',
    limits: { rpm: 55, tpm: 450_000 },
    embedding: { model: 'mistral-embed', rpm: 50 },
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', defaultModel: 'qwen/qwen3.8-27b',
    limits: { rpm: 30, tpm: 8_000, rpd: 1_000, tpd: 200_000 },
    extraBody: (model, env) => {
      const effort = env.GROQ_REASONING_EFFORT?.trim();
      if (/gpt-oss/iu.test(model)) return { include_reasoning: false, reasoning_effort: effort || 'low' };
      if (/qwen/iu.test(model)) return { reasoning_format: 'hidden', ...(effort ? { reasoning_effort: effort } : {}) };
      return {};
    },
  },
  gemini: {
    // Use a key from a Google project WITHOUT billing enabled so the free tier can never turn into charges.
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: 'GEMINI_API_KEY', defaultModel: 'gemini-3.1-flash-lite',
    limits: { rpm: 12, rpd: 400 },
    embedding: { model: 'gemini-embedding-001', rpm: 60 },
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', defaultModel: 'openai/gpt-oss-120b:free',
    limits: { rpm: 18, rpd: 45 },
  },
};

export interface ProviderSpec { provider: string; model: string; }

/** `mistral:mistral-large-latest` -> { provider: 'mistral', model: 'mistral-large-latest' }; a bare provider name uses its default model. */
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
    const [key, value] = part.split(':').map((item) => item.trim());
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
  // Hard safety rail: OpenRouter bills any model that is not an explicit ":free" variant.
  if (spec.provider === 'openrouter' && !spec.model.endsWith(':free')) throw new Error('OpenRouter models must end with ":free" so the bot can never incur charges');
  const limits = parseLimits(env[`LLM_LIMITS_${spec.provider.toUpperCase()}`]) ?? preset.limits;
  return new OpenAiCompatibleProvider({ name: spec.provider, baseUrl: preset.baseUrl, apiKey, model: spec.model, limits, extraBody: preset.extraBody?.(spec.model, env) ?? {}, timeoutMs: Number(env.LLM_TIMEOUT_MS) || 45_000 }, fetcher);
}

/** Primary first, then backups in the listed order. Missing keys for *backups* are skipped with a warning; a missing primary key is an error. */
export function buildLlm(env: EnvLike, fetcher?: FetchLike, warn: (message: string) => void = () => undefined): { llm: LlmProvider; specs: ProviderSpec[] } {
  const rawPrimary = env.LLM_PRIMARY?.trim() || (env.GROQ_API_KEY?.trim() ? `groq:${env.GROQ_MODEL?.trim() || PROVIDER_PRESETS.groq!.defaultModel}` : '');
  if (!rawPrimary) throw new Error('Set LLM_PRIMARY (for example "mistral:mistral-large-latest") and the matching API key.');
  const primary = parseProviderSpec(rawPrimary);
  const backups = (env.LLM_BACKUP ?? '').split(',').map((item) => item.trim()).filter(Boolean).map(parseProviderSpec);
  const providers: LlmProvider[] = [buildProvider(primary, env, fetcher)];
  const specs: ProviderSpec[] = [primary];
  for (const backup of backups) {
    try { providers.push(buildProvider(backup, env, fetcher)); specs.push(backup); }
    catch (error) { warn(`Backup provider ${backup.provider}:${backup.model} skipped: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { llm: providers.length === 1 ? providers[0]! : new FailoverProvider(providers), specs };
}

/** Embedding provider selection. `auto` picks the first configured provider with an embeddings preset. Returns undefined for `none`. */
export function buildEmbedder(env: EnvLike, fetcher?: FetchLike): Embedder | undefined {
  const choice = (env.EMBEDDING_PROVIDER?.trim().toLowerCase() || 'auto');
  if (choice === 'none' || choice === 'off') return undefined;
  const candidates = choice === 'auto' ? ['gemini', 'mistral'] : [choice];
  for (const name of candidates) {
    const preset = PROVIDER_PRESETS[name];
    if (!preset?.embedding) { if (choice !== 'auto') throw new Error(`Provider "${name}" has no embeddings preset`); continue; }
    const apiKey = env[preset.keyEnv]?.trim();
    if (!apiKey) { if (choice !== 'auto') throw new Error(`${preset.keyEnv} is required for EMBEDDING_PROVIDER=${name}`); continue; }
    return new OpenAiCompatibleEmbedder({ name, baseUrl: preset.baseUrl, apiKey, model: env.EMBEDDING_MODEL?.trim() || preset.embedding.model, rpm: preset.embedding.rpm }, fetcher);
  }
  return undefined;
}
