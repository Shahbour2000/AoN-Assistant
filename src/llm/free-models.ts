/**
 * The ONLY models this bot may ever call. Free-only by design: a model that is not listed here is rejected at startup,
 * so a typo, an old config or a copy-pasted paid model ID can never reach a billable endpoint.
 *
 * Every entry was checked against the provider's own documentation on 2026-11-20 (sources in README.md). Adding a model
 * means (1) confirming on the provider's site that it is usable on the free plan WITHOUT a payment method and
 * (2) adding it here together with a test. Anything unverified stays out.
 */

export interface FreeChatModel {
  /** Context window in tokens as published by the provider. */
  contextTokens: number;
  /** Rough free-tier ceilings used by the local limiter; see presets.ts for how they are applied. */
  note: string;
  /** Workers AI only: neurons per million tokens (published pricing page); used for the shared daily budget. */
  neurons?: { input: number; output: number };
}

export const FREE_CHAT_MODELS: Readonly<Record<string, Readonly<Record<string, FreeChatModel>>>> = {
  groq: {
    'qwen/qwen3.8-27b': { contextTokens: 131_072, note: 'Preview model (may be discontinued at short notice). 30 RPM, 1K RPD, 8K TPM, 200K TPD. Parallel tool calls.' },
    'openai/gpt-oss-120b': { contextTokens: 131_072, note: 'Production. 30 RPM, 1K RPD, 8K TPM, 200K TPD. One tool call at a time.' },
    'openai/gpt-oss-20b': { contextTokens: 131_072, note: 'Production. 30 RPM, 1K RPD, 8K TPM, 200K TPD. Smaller, weaker Arabic.' },
    'llama-3.3-70b-versatile': { contextTokens: 131_072, note: 'Production. Free limits not listed on the public table; conservative local limits applied.' },
    'llama-3.1-8b-instant': { contextTokens: 131_072, note: 'Production. Free limits not listed on the public table; conservative local limits applied. Weak for agent work.' },
  },
  cloudflare: {
    '@cf/openai/gpt-oss-120b': { contextTokens: 128_000, neurons: { input: 31_818, output: 68_182 }, note: 'Function calling supported. Shares the account-wide 10,000 neurons/day.' },
    '@cf/qwen/qwen3.8-27b': { contextTokens: 262_144, neurons: { input: 40_909, output: 290_909 }, note: 'Function calling supported; output is expensive in neurons, so keep reasoning low.' },
    '@cf/meta/llama-3.3-70b-instruct-fp8-fast': { contextTokens: 24_000, neurons: { input: 26_668, output: 204_805 }, note: 'Function calling supported; only a 24K context window.' },
  },
  openrouter: {
    'google/gemma-4-26b-a4b-it:free': { contextTokens: 262_144, note: 'Native function calling. Shared 20 RPM / 50 requests per DAY across ALL free models without purchased credits.' },
    'nvidia/nemotron-3.5-super-vl:free': { contextTokens: 1_000_000, note: 'Listed with tool use. Same shared 50 requests/day. Prompts may be retained by the free provider.' },
  },
};

export const FREE_EMBEDDING_MODELS: Readonly<Record<string, Readonly<Record<string, { neuronsPerMillionTokens: number; note: string }>>>> = {
  cloudflare: {
    '@cf/baai/bge-m3': { neuronsPerMillionTokens: 1_075, note: 'Multilingual embeddings; the whole wiki costs well under 1% of one day\'s free neurons.' },
  },
};

/**
 * Workers AI models that Cloudflare says need Workers Paid or prepaid AI Gateway credits (pricing page, 2026-11-20).
 * They are already excluded by the allowlist; this list exists so the error message can say exactly why, and so a test
 * proves they stay unreachable even if somebody widens the allowlist by mistake.
 */
export const KNOWN_PAID_ONLY_MODELS: ReadonlySet<string> = new Set([
  '@cf/moonshotai/kimi-k2.6',
  '@cf/moonshotai/kimi-k2.7-code',
  '@cf/zai-org/glm-5.2',
  '@cf/zai-org/glm-5.3',
  '@cf/zai-org/glm-5.3-flash',
  '@cf/deepseek-ai/deepseek-v4-flash-0731',
  '@cf/deepseek-ai/deepseek-v4.1-flash-1017',
  '@cf/deepseek-ai/deepseek-v4-pro-0813',
  '@cf/thinkingmachines/inkling-2-small',
]);

/** Throws unless `model` is an explicitly approved free chat model of `provider`. */
export function assertFreeChatModel(provider: string, model: string): void {
  if (KNOWN_PAID_ONLY_MODELS.has(model)) throw new Error(`Model "${model}" requires a paid billing method on ${provider} and is blocked (this bot is free-only).`);
  const allowed = FREE_CHAT_MODELS[provider];
  if (!allowed) throw new Error(`Provider "${provider}" has no approved free chat models.`);
  if (!Object.prototype.hasOwnProperty.call(allowed, model)) {
    throw new Error(`Model "${model}" is not on the approved free-model list for ${provider}. Approved: ${Object.keys(allowed).join(', ')}. (Unknown IDs are rejected so a paid model can never be selected by accident; see src/llm/free-models.ts.)`);
  }
  // Belt and braces: OpenRouter only guarantees $0 for explicit ":free" variants.
  if (provider === 'openrouter' && !model.endsWith(':free')) throw new Error('OpenRouter models must end with ":free" so the bot can never incur charges');
}

export function assertFreeEmbeddingModel(provider: string, model: string): void {
  const allowed = FREE_EMBEDDING_MODELS[provider];
  if (!allowed || !Object.prototype.hasOwnProperty.call(allowed, model)) {
    throw new Error(`Embedding model "${model}" is not on the approved free list for ${provider}. Approved: ${Object.keys(allowed ?? {}).join(', ') || '(none)'}.`);
  }
}
