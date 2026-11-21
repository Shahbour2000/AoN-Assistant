/** Provider-agnostic chat and embedding types. Nothing here knows about Groq, Mistral, Gemini, etc. */

export interface ToolCall { id: string; name: string; arguments: string; }
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  /** assistant messages that requested tools */
  toolCalls?: ToolCall[];
  /** tool messages answer one tool call */
  toolCallId?: string;
  name?: string;
}
export interface ToolSpec { name: string; description: string; parameters: Record<string, unknown>; }

export interface ChatRequest {
  messages: ChatMessage[];
  tools?: ToolSpec[];
  /** When false the model must not call tools even if tools are supplied. Default: auto. */
  toolChoice?: 'auto' | 'none';
  maxTokens?: number;
  temperature?: number;
  /** Ask for a JSON object (used by the verifier/summariser). */
  json?: boolean;
}
export interface ChatResponse {
  content: string;
  toolCalls: ToolCall[];
  finishReason?: string | undefined;
  usage?: { promptTokens?: number | undefined; completionTokens?: number | undefined } | undefined;
  provider: string;
  model: string;
}
export interface LlmProvider {
  /** Human-readable id such as `mistral:mistral-large-latest`. */
  readonly id: string;
  chat(request: ChatRequest): Promise<ChatResponse>;
}
export interface Embedder {
  readonly id: string;
  embed(texts: string[], purpose: 'query' | 'document'): Promise<number[][]>;
}

export type LlmFailureKind = 'rate_limit' | 'unauthorized' | 'forbidden' | 'timeout' | 'unavailable' | 'network' | 'bad_request' | 'invalid_response';
/** Failures after which trying another provider is sensible. */
const FAILOVER_KINDS: ReadonlySet<LlmFailureKind> = new Set(['rate_limit', 'timeout', 'unavailable', 'network', 'invalid_response', 'unauthorized', 'forbidden']);

export class LlmError extends Error {
  constructor(readonly kind: LlmFailureKind, message: string, readonly details: { provider?: string; status?: number; retryAfterSeconds?: number; providerMessage?: string } = {}) {
    super(message);
    this.name = 'LlmError';
  }
  get status(): number | undefined { return this.details.status; }
  get retryAfterSeconds(): number | undefined { return this.details.retryAfterSeconds; }
  get failoverEligible(): boolean { return FAILOVER_KINDS.has(this.kind); }
}
