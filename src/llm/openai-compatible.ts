import { postJson, type FetchLike } from './http.js';
import { logger } from '../logging/logger.js';
import { LocalLimiter, NeuronBudget, secondsUntilUtcMidnight, type ProviderLimits } from './limiter.js';
import { estimateMessagesTokens, estimateTokens } from './tokens.js';
import { LlmError, type ChatMessage, type ChatRequest, type ChatResponse, type Embedder, type LlmProvider, type ToolCall } from './types.js';

export interface OpenAiCompatibleConfig {
  /** Short provider name used in ids and logs, e.g. `groq`. */
  name: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  /** Extra JSON body fields for provider-specific settings (reasoning effort etc.). */
  extraBody?: Record<string, unknown>;
  limits?: ProviderLimits;
  /** Maximum number of automatic retries for short 429/5xx waits inside this provider. */
  retries?: number;
  /** Workers AI: shared daily free-neuron budget and this model's published neuron prices (per million tokens). */
  budget?: { tracker: NeuronBudget; inputPerMillion: number; outputPerMillion: number };
  /** Error text that means "today's free quota is gone"; such errors become a rate_limit with a long cool-down so the provider is not retried until it resets. */
  dailyQuota?: { pattern: RegExp; cooldownSeconds?: () => number };
}

/** Convert provider-specific "daily free quota exhausted" failures into a rate_limit with a retry time. */
function mapDailyQuota(error: unknown, config: OpenAiCompatibleConfig): unknown {
  const quota = config.dailyQuota;
  if (!quota || !(error instanceof LlmError) || error.kind === 'timeout' || error.kind === 'network' || error.kind === 'unauthorized') return error;
  if (!quota.pattern.test(error.details.providerMessage ?? error.message)) return error;
  return new LlmError('rate_limit', error.message, { ...error.details, source: 'daily_quota', retryAfterSeconds: Math.max(error.retryAfterSeconds ?? 0, (quota.cooldownSeconds ?? secondsUntilUtcMidnight)()) });
}

/** Remove reasoning blocks some models leak into `content`. */
export function stripReasoning(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/giu, '').replace(/^[\s\S]*?<\/think>/iu, '').trim();
}

export function toWireMessages(messages: ChatMessage[]): Array<Record<string, unknown>> {
  return messages.map((message) => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: message.content ?? '' };
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return { role: 'assistant', content: message.content ?? null, tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: 'function', function: { name: call.name, arguments: call.arguments } })) };
    }
    return { role: message.role, content: message.content ?? '' };
  });
}

export class OpenAiCompatibleProvider implements LlmProvider {
  readonly id: string;
  private readonly limiter: LocalLimiter | undefined;
  /** Optional provider-specific parameters (e.g. reasoning_effort) that the provider rejected; they are left out from then on. */
  private readonly droppedParams = new Set<string>();
  constructor(private readonly config: OpenAiCompatibleConfig, private readonly fetcher: FetchLike = fetch, limiter?: LocalLimiter, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.id = `${config.name}:${config.model}`;
    this.limiter = limiter ?? (config.limits ? new LocalLimiter(config.limits) : undefined);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const estimated = estimateMessagesTokens(request.messages) + (request.tools ?? []).reduce((sum, tool) => sum + estimateTokens(JSON.stringify(tool)), 0) + Math.min(request.maxTokens ?? 1024, COMPLETION_RESERVE_TOKENS);
    const budget = this.config.budget;
    const neuronEstimate = budget ? ((estimated - Math.min(request.maxTokens ?? 1024, COMPLETION_RESERVE_TOKENS)) * budget.inputPerMillion + Math.min(request.maxTokens ?? 1024, COMPLETION_RESERVE_TOKENS) * budget.outputPerMillion) / 1e6 : 0;
    try {
      await this.limiter?.acquire(estimated, this.config.name, this.config.model);
      try { budget?.tracker.reserve(neuronEstimate, this.config.name); }
      catch (error) { this.limiter?.settle(0, estimated); throw error; }
    } catch (error) {
      // Our own limits stopped this request: it was NOT sent to the provider. Say which limit, with the numbers.
      if (error instanceof LlmError) logger.warn('LLM request blocked by a LOCAL limit (not sent to the provider)', { provider: this.config.name, model: this.config.model, source: error.source, limit: error.details.limit, requestedTokens: error.details.requestedTokens, usedTokens: error.details.usedTokens, maxTokens: error.details.maxTokens, retryAfterSeconds: error.retryAfterSeconds });
      throw error;
    }
    const tools = request.tools?.length ? request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : undefined;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toWireMessages(request.messages),
      max_tokens: request.maxTokens ?? 1024,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(tools ? { tools, tool_choice: request.toolChoice === 'none' ? 'none' : 'auto' } : {}),
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      ...Object.fromEntries(Object.entries(this.config.extraBody ?? {}).filter(([key]) => !this.droppedParams.has(key))),
    };
    let payload: unknown;
    try { payload = await this.send(body); }
    catch (error) {
      budget?.tracker.settle(0, neuronEstimate);
      this.limiter?.settle(0, estimated);
      const mapped = mapDailyQuota(error, this.config);
      if (mapped instanceof LlmError) logger.warn('LLM provider rejected the request', { provider: this.config.name, model: this.config.model, kind: mapped.kind, status: mapped.status, source: mapped.source, reachedProvider: mapped.details.reachedProvider, retryAfterSeconds: mapped.retryAfterSeconds, detail: mapped.details.providerMessage });
      throw mapped;
    }
    const choice = (payload as { choices?: Array<{ message?: { content?: unknown; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> }; finish_reason?: string }>; usage?: { prompt_tokens?: number; completion_tokens?: number } })?.choices?.[0];
    if (!choice?.message) throw new LlmError('invalid_response', `${this.config.name} returned no choices`, { provider: this.config.name });
    const rawCalls = choice.message.tool_calls ?? [];
    const toolCalls: ToolCall[] = rawCalls.map((call, index) => ({
      id: call.id || `call_${Date.now().toString(36)}_${index}`,
      name: String(call.function?.name ?? ''),
      arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : JSON.stringify(call.function?.arguments ?? {}),
    })).filter((call) => call.name);
    const content = typeof choice.message.content === 'string' ? stripReasoning(choice.message.content) : '';
    const usage = (payload as { usage?: { prompt_tokens?: number; completion_tokens?: number } }).usage;
    if (usage?.prompt_tokens !== undefined) this.limiter?.settle((usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0), estimated);
    if (budget && usage?.prompt_tokens !== undefined) budget.tracker.settle(((usage.prompt_tokens ?? 0) * budget.inputPerMillion + (usage.completion_tokens ?? 0) * budget.outputPerMillion) / 1e6, neuronEstimate);
    logger.info('LLM request served', { provider: this.config.name, model: this.config.model, promptTokens: usage?.prompt_tokens, completionTokens: usage?.completion_tokens, toolCalls: toolCalls.length, ...(budget ? { neuronsUsedToday: Math.round(budget.tracker.usedToday) } : {}) });
    return { content, toolCalls, finishReason: choice.finish_reason, usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } : undefined, provider: this.config.name, model: this.config.model };
  }

  private async send(body: Record<string, unknown>): Promise<unknown> {
    const retries = this.config.retries ?? 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await postJson(this.fetcher, `${this.config.baseUrl.replace(/\/$/u, '')}/chat/completions`, this.config.apiKey, body, this.config.timeoutMs ?? 45_000, this.config.name);
      } catch (error) {
        if (error instanceof LlmError && error.kind === 'bad_request') {
          const optional = Object.keys(this.config.extraBody ?? {}).find((key) => !this.droppedParams.has(key) && key === 'reasoning_effort' && new RegExp(key.replace(/_/gu, '.?'), 'iu').test(error.details.providerMessage ?? ''));
          if (optional) { logger.warn('Provider rejected an optional parameter; retrying without it from now on', { provider: this.config.name, model: this.config.model, parameter: optional }); this.droppedParams.add(optional); delete body[optional]; continue; }
        }
        const retryable = error instanceof LlmError && (error.kind === 'unavailable' || error.kind === 'network' || (error.kind === 'rate_limit' && (error.retryAfterSeconds ?? 99) <= 5));
        if (!retryable || attempt >= retries) throw error;
        await this.sleep(error.kind === 'rate_limit' ? (error.retryAfterSeconds ?? 1) * 1000 : 600 * (attempt + 1));
      }
    }
  }
}

/** Tokens reserved for the answer when checking local limits (the real usage replaces it afterwards). Reserving the full max_tokens made a single call look 2-3x bigger than it was. */
const COMPLETION_RESERVE_TOKENS = 600;

export interface EmbeddingConfig { budget?: { tracker: NeuronBudget; neuronsPerMillionTokens: number }; dailyQuota?: OpenAiCompatibleConfig['dailyQuota']; name: string; baseUrl: string; apiKey: string; model: string; timeoutMs?: number; batchSize?: number; /** max requests/minute we allow ourselves */ rpm?: number; }

/** OpenAI-compatible `/embeddings` client (works for Mistral and Gemini's OpenAI-compatible endpoint). */
export class OpenAiCompatibleEmbedder implements Embedder {
  readonly id: string;
  private readonly limiter: LocalLimiter | undefined;
  constructor(private readonly config: EmbeddingConfig, private readonly fetcher: FetchLike = fetch) {
    this.id = `${config.name}:${config.model}`;
    this.limiter = config.rpm ? new LocalLimiter({ rpm: config.rpm }, Date.now, undefined, 30_000) : undefined;
  }
  async embed(texts: string[], _purpose: 'query' | 'document'): Promise<number[][]> {
    const out: number[][] = [];
    const batch = this.config.batchSize ?? 16;
    for (let start = 0; start < texts.length; start += batch) {
      const slice = texts.slice(start, start + batch).map((text) => text.slice(0, 6000));
      await this.limiter?.acquire(0, this.config.name);
      const budget = this.config.budget;
      const neurons = budget ? (slice.reduce((sum, text) => sum + estimateTokens(text), 0) * budget.neuronsPerMillionTokens) / 1e6 : 0;
      budget?.tracker.reserve(neurons, this.config.name);
      let payload: { data?: Array<{ embedding?: number[]; index?: number }> };
      try { payload = await postJson(this.fetcher, `${this.config.baseUrl.replace(/\/$/u, '')}/embeddings`, this.config.apiKey, { model: this.config.model, input: slice }, this.config.timeoutMs ?? 30_000, this.config.name) as typeof payload; }
      catch (error) { budget?.tracker.settle(0, neurons); throw mapDailyQuota(error, this.config as unknown as OpenAiCompatibleConfig); }
      const rows = payload.data;
      if (!Array.isArray(rows) || rows.length !== slice.length) throw new LlmError('invalid_response', `${this.config.name} embeddings response had unexpected shape`, { provider: this.config.name });
      const ordered = [...rows].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
      for (const row of ordered) {
        if (!Array.isArray(row.embedding) || !row.embedding.length) throw new LlmError('invalid_response', `${this.config.name} returned an empty embedding`, { provider: this.config.name });
        out.push(row.embedding);
      }
    }
    return out;
  }
}
