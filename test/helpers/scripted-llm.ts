import type { ChatRequest, ChatResponse, LlmProvider, ToolCall } from '../../src/llm/types.js';

export type Step = ChatResponse | ((request: ChatRequest, index: number) => Partial<ChatResponse>);
/** Deterministic stand-in for a model: replays scripted replies and records every request. NOT a test of model quality. */
export class ScriptedLlm implements LlmProvider {
  readonly id = 'scripted:test';
  requests: ChatRequest[] = [];
  constructor(private readonly steps: Array<Step | Partial<ChatResponse>>) {}
  async chat(request: ChatRequest): Promise<ChatResponse> {
    const index = this.requests.length;
    this.requests.push(JSON.parse(JSON.stringify(request)) as ChatRequest);
    const step = this.steps[Math.min(index, this.steps.length - 1)]!;
    const partial = typeof step === 'function' ? step(request, index) : step;
    return { content: '', toolCalls: [], provider: 'scripted', model: 'test', ...partial };
  }
}
export const call = (name: string, args: unknown, id = `c${Math.random().toString(36).slice(2, 8)}`): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
