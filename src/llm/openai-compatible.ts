import { postJson, type FetchLike } from './http.js';
import { LocalLimiter, type ProviderLimits } from './limiter.js';
import { estimateMessagesTokens, estimateTokens } from './tokens.js';
import { LlmError, type ChatMessage, type ChatRequest, type ChatResponse, type Embedder, type LlmProvider, type ToolCall } from './types.js';

export interface OpenAiCompatibleConfig {
  /** Short provider name used in ids and logs, e.g. `mistral`. */
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
  constructor(private readonly config: OpenAiCompatibleConfig, private readonly fetcher: FetchLike = fetch, limiter?: LocalLimiter, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))) {
    this.id = `${config.name}:${config.model}`;
    this.limiter = limiter ?? (config.limits ? new LocalLimiter(config.limits) : undefined);
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const estimated = estimateMessagesTokens(request.messages) + (request.tools ?? []).reduce((sum, tool) => sum + estimateTokens(JSON.stringify(tool)), 0) + Math.min(request.maxTokens ?? 1024, COMPLETION_RESERVE_TOKENS);
    await this.limiter?.acquire(estimated, this.config.name);
    const tools = request.tools?.length ? request.tools.map((tool) => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) : undefined;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: toWireMessages(request.messages),
      max_tokens: request.maxTokens ?? 1024,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(tools ? { tools, tool_choice: request.toolChoice === 'none' ? 'none' : 'auto' } : {}),
      ...(request.json ? { response_format: { type: 'json_object' } } : {}),
      ...this.config.extraBody,
    };
    const payload = await this.send(body);
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
    return { content, toolCalls, finishReason: choice.finish_reason, usage: usage ? { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens } : undefined, provider: this.config.name, model: this.config.model };
  }

  private async send(body: Record<string, unknown>): Promise<unknown> {
    const retries = this.config.retries ?? 1;
    for (let attempt = 0; ; attempt++) {
      try {
        return await postJson(this.fetcher, `${this.config.baseUrl.replace(/\/$/u, '')}/chat/completions`, this.config.apiKey, body, this.config.timeoutMs ?? 45_000, this.config.name);
      } catch (error) {
        const retryable = error instanceof LlmError && (error.kind === 'unavailable' || error.kind === 'network' || (error.kind === 'rate_limit' && (error.retryAfterSeconds ?? 99) <= 5));
        if (!retryable || attempt >= retries) throw error;
        await this.sleep(error.kind === 'rate_limit' ? (error.retryAfterSeconds ?? 1) * 1000 : 600 * (attempt + 1));
      }
    }
  }
}

/** Tokens reserved for the answer when checking local limits (the real usage replaces it afterwards). Reserving the full max_tokens made a single call look 2-3x bigger than it was. */
const COMPLETION_RESERVE_TOKENS = 600;

export interface EmbeddingConfig { name: string; baseUrl: string; apiKey: string; model: string; timeoutMs?: number; batchSize?: number; /** max requests/minute we allow ourselves */ rpm?: number; }

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
      const payload = await postJson(this.fetcher, `${this.config.baseUrl.replace(/\/$/u, '')}/embeddings`, this.config.apiKey, { model: this.config.model, input: slice }, this.config.timeoutMs ?? 30_000, this.config.name) as { data?: Array<{ embedding?: number[]; index?: number }> };
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
