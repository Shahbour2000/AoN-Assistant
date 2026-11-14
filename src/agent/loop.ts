import { logger } from '../logging/logger.js';
import { LlmError, type ChatMessage, type LlmProvider } from '../llm/types.js';
import type { AgentTool, ToolContext, ToolResult } from './tools/index.js';
import { InvalidInput } from './tools/types.js';
import { validateDeterministic, verifyWithLlm, type EvidenceEntry, type Issue } from './validator.js';

export interface AgentOptions {
  llm: LlmProvider;
  tools: AgentTool[];
  toolContext: ToolContext;
  /** `basic` = deterministic checks, `llm` = plus an LLM audit of game-grounded answers, `off` = none. */
  validation?: 'off' | 'basic' | 'llm';
  maxSteps?: number;
  maxToolCalls?: number;
  maxRevisions?: number;
  maxTokens?: number;
  toolTimeoutMs?: number;
}
export interface AgentInput {
  system: string; history: ChatMessage[]; userMessage: string;
  /**
   * Local wiki search run BEFORE the first model call (free: no model tokens). When it finds passages they are handed to the model as the
   * result of its own `search_knowledge` call, which saves a whole model round trip for most game questions. The model may still search again.
   */
  prefetchQueries?: string[] | undefined;
}
export interface TraceEntry { step: number; tool: string; args: string; status: string; ms: number; }
export interface AgentOutcome {
  answer: string;
  trace: TraceEntry[];
  evidence: EvidenceEntry[];
  llmCalls: number;
  revisions: number;
  unresolvedIssues: Issue[];
  provider: string;
}

const MAX_TOOL_RESULT_CHARS = 9000;

export async function runAgent(options: AgentOptions, input: AgentInput): Promise<AgentOutcome> {
  const { llm, tools, toolContext } = options;
  const maxSteps = options.maxSteps ?? 6;
  const maxToolCalls = options.maxToolCalls ?? 12;
  const maxRevisions = options.maxRevisions ?? 1;
  const validation = options.validation ?? 'basic';
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  const specs = tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }));
  const messages: ChatMessage[] = [{ role: 'system', content: input.system }, ...input.history, { role: 'user', content: input.userMessage }];
  const trace: TraceEntry[] = [];
  const evidence: EvidenceEntry[] = [];
  const cache = new Map<string, Promise<{ result: ToolResult; ms: number }>>();
  let llmCalls = 0;
  let toolCalls = 0;
  let revisions = 0;
  let step = 0;
  let provider = llm.id;
  let emptyRetries = 0;
  let maxTokens = options.maxTokens ?? 1400;
  const historyText = input.history.map((message) => message.content ?? '').join('\n');

  if (input.prefetchQueries?.length && byName.has('search_knowledge')) {
    const args = JSON.stringify({ queries: input.prefetchQueries, limit: 4 });
    const { result, ms } = await executeTool('search_knowledge', args, byName, toolContext, cache, options.toolTimeoutMs ?? 25_000);
    if (result.status === 'ok') {
      const text = serialize(result);
      messages.push({ role: 'assistant', content: null, toolCalls: [{ id: 'prefetch1', name: 'search_knowledge', arguments: args }] });
      messages.push({ role: 'tool', toolCallId: 'prefetch1', name: 'search_knowledge', content: text });
      trace.push({ step: 0, tool: 'search_knowledge', args: `(automatic) ${args.slice(0, 280)}`, status: result.status, ms });
      evidence.push({ tool: 'search_knowledge', kind: 'knowledge', args, status: result.status, text });
    }
  }

  for (;;) {
    step++;
    const lastChance = step >= maxSteps || toolCalls >= maxToolCalls;
    if (lastChance && messages[messages.length - 1]?.role === 'tool') {
      messages.push({ role: 'user', content: '[system note] Tool budget reached. Answer the player now using only what you have gathered. If something is missing, say so plainly.' });
    }
    const response = await llm.chat({ messages, ...(specs.length ? { tools: specs } : {}), toolChoice: lastChance ? 'none' : 'auto', maxTokens, temperature: 0.3 });
    llmCalls++;
    provider = `${response.provider}:${response.model}`;

    if (response.toolCalls.length && !lastChance) {
      messages.push({ role: 'assistant', content: response.content || null, toolCalls: response.toolCalls });
      const calls = response.toolCalls.slice(0, Math.max(1, maxToolCalls - toolCalls));
      toolCalls += calls.length;
      const results = await Promise.all(calls.map((call) => executeTool(call.name, call.arguments, byName, toolContext, cache, options.toolTimeoutMs ?? 25_000)));
      calls.forEach((call, index) => {
        const { result, ms } = results[index]!;
        const text = serialize(result);
        trace.push({ step, tool: call.name, args: call.arguments.slice(0, 300), status: result.status, ms });
        evidence.push({ tool: call.name, kind: byName.get(call.name)?.kind ?? 'utility', args: call.arguments, status: result.status, text });
        messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: text });
      });
      // Providers require every tool call to be answered, including ones dropped by the budget.
      for (const call of response.toolCalls.slice(calls.length)) messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: JSON.stringify({ status: 'invalid_input', note: 'Tool budget reached; call skipped.' }) });
      continue;
    }

    const draft = response.content.trim();
    if (!draft) {
      // Empty completions happen: reasoning models can spend the whole token budget thinking, and providers sometimes return nothing.
      // Log why (this is what a developer needs to see), then retry: with a bigger budget if it ran out, otherwise with a nudge.
      logger.warn('Model returned an empty answer', { provider, finishReason: response.finishReason, completionTokens: response.usage?.completionTokens, maxTokens, step, retry: emptyRetries });
      if (emptyRetries++ < 2) {
        if (response.finishReason === 'length') maxTokens = Math.min(maxTokens * 2, 4096);
        else messages.push({ role: 'user', content: '[system note] Your last reply was empty. Reply to the player now.' });
        continue;
      }
      throw new LlmError('invalid_response', `The model returned an empty answer ${emptyRetries} times (finish reason: ${response.finishReason ?? 'unknown'})`, { provider: response.provider });
    }

    const issues = validation === 'off' ? [] : await audit({ question: input.userMessage, history: historyText, answer: draft, evidence }, llm, validation === 'llm');
    if (!issues.length) return { answer: draft, trace, evidence, llmCalls, revisions, unresolvedIssues: [], provider };
    logger.info('Answer failed validation', { issues: issues.map((issue) => issue.code), revisions });
    if (revisions >= maxRevisions) return { answer: draft, trace, evidence, llmCalls, revisions, unresolvedIssues: issues, provider };
    revisions++;
    messages.push({ role: 'assistant', content: draft });
    messages.push({ role: 'user', content: `[system note — not from the player] Your draft has problems:\n${issues.map((issue) => `- ${issue.message}`).join('\n')}\nFix them. You may call tools if you need evidence. Reply with the corrected final answer only, in the player's language, without mentioning this note.` });
    step = Math.min(step, maxSteps - 2); // leave room for at least one tool round while revising
  }
}

async function audit(input: Parameters<typeof validateDeterministic>[0], llm: LlmProvider, useLlm: boolean): Promise<Issue[]> {
  const issues = validateDeterministic(input);
  if (!issues.length && useLlm && input.evidence.some((entry) => entry.kind !== 'utility' && (entry.status === 'ok' || entry.status === 'partial'))) {
    try { issues.push(...await verifyWithLlm(llm, input)); }
    catch (error) { logger.warn('LLM verification skipped', { error: error instanceof Error ? error.message : String(error) }); }
  }
  return issues;
}

async function executeTool(name: string, rawArgs: string, byName: Map<string, AgentTool>, context: ToolContext, cache: Map<string, Promise<{ result: ToolResult; ms: number }>>, timeoutMs: number): Promise<{ result: ToolResult; ms: number }> {
  const key0 = `${name}:${rawArgs}`;
  const existing = cache.get(key0);
  // Identical calls (even concurrent ones in the same step) share one execution: saves API quota and prevents loops.
  if (existing) return existing.then((first) => ({ result: first.result, ms: 0 }));
  const run = executeOnce(name, rawArgs, byName, context, timeoutMs);
  cache.set(key0, run);
  void run.then(({ result }) => { if (!['ok', 'partial', 'not_found'].includes(result.status)) cache.delete(key0); });
  return run;
}

async function executeOnce(name: string, rawArgs: string, byName: Map<string, AgentTool>, context: ToolContext, timeoutMs: number): Promise<{ result: ToolResult; ms: number }> {
  const started = Date.now();
  const tool = byName.get(name);
  if (!tool) return { result: { status: 'invalid_input', note: `Unknown tool "${name}". Available: ${[...byName.keys()].join(', ')}` }, ms: 0 };
  let args: Record<string, unknown>;
  try {
    const parsed: unknown = rawArgs.trim() ? JSON.parse(rawArgs) : {};
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    args = parsed as Record<string, unknown>;
  } catch { return { result: { status: 'invalid_input', note: 'Tool arguments were not a valid JSON object. Call the tool again with valid arguments.' }, ms: 0 }; }
  try {
    const result = await Promise.race([tool.execute(args, context), new Promise<never>((_, reject) => setTimeout(() => reject(new Error('tool_timeout')), timeoutMs).unref?.())]);
    return { result, ms: Date.now() - started };
  } catch (error) {
    if (error instanceof InvalidInput) return { result: { status: 'invalid_input', note: error.message }, ms: Date.now() - started };
    const timeout = error instanceof Error && error.message === 'tool_timeout';
    logger.warn('Tool crashed', { tool: name, error: error instanceof Error ? error.message : String(error) });
    return { result: { status: 'unavailable', kind: timeout ? 'timeout' : 'tool_error', note: 'The tool failed temporarily. This is not evidence about the requested data. Do not invent values.' }, ms: Date.now() - started };
  }
}

function serialize(result: ToolResult): string {
  const text = JSON.stringify(result);
  if (text.length <= MAX_TOOL_RESULT_CHARS) return text;
  return JSON.stringify({ status: result.status, truncated: true, note: 'Result too large; narrower request needed.', preview: text.slice(0, MAX_TOOL_RESULT_CHARS - 200) });
}
