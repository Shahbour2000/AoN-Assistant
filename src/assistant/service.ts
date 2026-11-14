import type { LinkedPlayerRepository, MessageRepository } from '../database/repositories.js';
import { runAgent, type AgentOutcome } from '../agent/loop.js';
import { ConversationMemory } from '../agent/memory.js';
import { buildSystemPrompt } from '../agent/prompt.js';
import { createTools, type ActivePlayer, type GameApi, type ToolContext } from '../agent/tools/index.js';
import type { KnowledgeBase } from '../knowledge/index.js';
import type { LlmProvider } from '../llm/types.js';
import { logger } from '../logging/logger.js';

export interface AskInput { guildId: string; userId: string; question: string; conversationId?: string; channelId?: string; }
export class AssistantRateLimitError extends Error { constructor(readonly retryAfterSeconds: number) { super('Assistant application request limit reached'); this.name = 'AssistantRateLimitError'; } }
export class AssistantRequestGate {
  private readonly userTimes = new Map<string, number[]>();
  private globalTimes: number[] = [];
  constructor(private readonly now: () => number = Date.now, private readonly perUserLimit = 12, private readonly globalLimit = 120, private readonly windowMs = 60_000) {}
  admit(userKey: string): void {
    const current = this.now();
    this.globalTimes = this.globalTimes.filter((at) => at > current - this.windowMs);
    const user = (this.userTimes.get(userKey) ?? []).filter((at) => at > current - this.windowMs);
    const blockedAt = this.globalTimes.length >= this.globalLimit ? this.globalTimes[0]! : user.length >= this.perUserLimit ? user[0]! : undefined;
    if (blockedAt !== undefined) throw new AssistantRateLimitError(Math.max(1, Math.ceil((blockedAt + this.windowMs - current) / 1000)));
    user.push(current); this.globalTimes.push(current); this.userTimes.set(userKey, user);
  }
}

export interface AssistantDeps {
  llm: LlmProvider;
  messages: MessageRepository;
  knowledge?: KnowledgeBase | undefined;
  api?: GameApi | undefined;
  links?: LinkedPlayerRepository | undefined;
  validation?: 'off' | 'basic' | 'llm';
  requestGate?: AssistantRequestGate;
  now?: () => Date;
}

const ACTIVE_PLAYER_TTL_MS = 2 * 3_600_000;
const UNVERIFIED_NOTE = (arabic: boolean) => arabic ? '\n\n_ملاحظة: مقدرتش أتأكد من بعض الأرقام دي من مصادري، فاعتبرها تقريبية._' : '\n\n_Note: I could not verify some of the figures above against my sources, so treat them as approximate._';

export class AssistantService {
  private readonly memory: ConversationMemory;
  private readonly gate: AssistantRequestGate;
  constructor(private readonly deps: AssistantDeps) {
    this.memory = new ConversationMemory(deps.messages);
    this.gate = deps.requestGate ?? new AssistantRequestGate();
  }

  async ask(input: AskInput): Promise<string> {
    this.gate.admit(JSON.stringify([input.guildId, input.userId]));
    const { messages, knowledge, api, llm } = this.deps;
    const scopeId = JSON.stringify([input.guildId, input.channelId ?? 'default', input.conversationId ?? null, input.userId]);
    const historyScope = input.channelId ? JSON.stringify([input.channelId, input.conversationId ?? null]) : undefined;
    const memory = this.memory.load(input.guildId, input.userId, historyScope);

    // Temporary, per-conversation player context (expires); a linked account is only a convenience default.
    let active: ActivePlayer | undefined;
    const stored = messages.getAssistantContext(scopeId);
    if (stored?.selectedPlayerId && stored.selectedPlayerName && Date.now() - Date.parse(stored.updatedAt) < ACTIVE_PLAYER_TTL_MS) active = { id: stored.selectedPlayerId, username: stored.selectedPlayerName, fetchedAt: stored.selectedFetchedAt ?? stored.updatedAt };
    else { const linked = this.deps.links?.getByDiscordUser(input.userId); if (linked) active = { id: linked.playerId, username: linked.username, fetchedAt: linked.linkedAt }; }

    const toolContext: ToolContext = {
      knowledge, api,
      getActivePlayer: () => active,
      setActivePlayer: (player) => { active = player; messages.setAssistantContext(scopeId, { selectedPlayerId: player.id, selectedPlayerName: player.username, selectedFetchedAt: player.fetchedAt, waitingForUsername: false, updatedAt: new Date().toISOString() }); },
      now: () => Date.now(),
    };
    const tools = createTools({ knowledge, api });
    const system = buildSystemPrompt({ now: this.deps.now?.() ?? new Date(), knowledgeOutline: knowledge?.outline(), hasKnowledge: Boolean(knowledge), hasGameApi: Boolean(api), summary: memory.summary, activePlayer: active });

    let outcome: AgentOutcome;
    try {
      outcome = await runAgent({ llm, tools, toolContext, validation: this.deps.validation ?? 'basic' }, { system, history: memory.messages, userMessage: input.question });
    } catch (error) {
      logger.error('Assistant pipeline failed', { guildId: input.guildId, userId: input.userId, conversationId: input.conversationId, error: error instanceof Error ? error.message : String(error) });
      throw error;
    }

    let answer = outcome.answer;
    if (outcome.unresolvedIssues.some((issue) => issue.code === 'ungrounded_numbers' || issue.code === 'unsupported_claims')) answer += UNVERIFIED_NOTE(/[؀-ۿ]/u.test(input.question));
    logger.info('Assistant answered', { guildId: input.guildId, userId: input.userId, provider: outcome.provider, llmCalls: outcome.llmCalls, revisions: outcome.revisions, tools: outcome.trace.map((t) => `${t.tool}:${t.status}`), unresolved: outcome.unresolvedIssues.map((i) => i.code) });
    const sessionId = this.persist(input, historyScope, answer);
    void this.memory.maybeSummarise(sessionId, llm);
    return answer;
  }

  private persist(input: AskInput, historyScope: string | undefined, answer: string): string {
    const now = new Date().toISOString();
    const write = (role: 'user' | 'model', content: string) => historyScope
      ? this.deps.messages.appendForScope({ guildId: input.guildId, userId: input.userId, role, content, createdAt: now }, historyScope)
      : this.deps.messages.appendForUser({ guildId: input.guildId, userId: input.userId, role, content, createdAt: now });
    write('user', input.question);
    return write('model', answer).sessionId;
  }
}
