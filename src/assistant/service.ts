import type { MessageRepository } from '../database/repositories.js';
import type { AnswerProvider } from '../groq/client.js';
import type { KnowledgeChunk } from '../knowledge/retrieval.js';
import { logger } from '../logging/logger.js';
import type { LinkedPlayerRepository } from '../database/repositories.js';
import { AonApiClient } from '../aon-api/client.js';
import { createAgentTools, type PlayerSelection } from './tools.js';
import { selectOnboardingStage, mentorBrief } from '../aon-api/onboarding.js';
import type { PlayerSnapshot } from '../aon-api/client.js';

export interface AskInput { guildId: string; userId: string; question: string; conversationId?: string; channelId?: string; }
interface PlayerConversationState { selectedId?: string; username?: string; fetchedAt?: string; waitingForUsername: boolean; lastLookup?: 'found' | 'not_found' | 'unavailable'; }
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

export class AssistantService {
  constructor(private readonly provider: AnswerProvider, private readonly messages: MessageRepository, private readonly chunks: KnowledgeChunk[], private readonly players?: { links: LinkedPlayerRepository; api: AonApiClient }, private readonly apiReference?: string, private readonly requestGate = new AssistantRequestGate()) {}
  async ask(input: AskInput): Promise<string> {
    let stage = 'knowledge_retrieval';
    try {
      this.requestGate.admit(JSON.stringify([input.guildId, input.userId]));
      stage = 'load_conversation_history';
      const scopeId = JSON.stringify([input.guildId, input.channelId ?? 'default', input.conversationId ?? null, input.userId]);
      const historyScope = JSON.stringify([input.channelId ?? 'default', input.conversationId ?? null]);
      const history = input.channelId ? this.messages.listForScope(input.guildId, historyScope, input.userId, 20) : this.messages.listForUser(input.guildId, input.userId, 20);
      const storedState = this.messages.getAssistantContext(scopeId);
      const state: PlayerConversationState = { ...(storedState?.selectedPlayerId ? { selectedId: storedState.selectedPlayerId } : {}), ...(storedState?.selectedPlayerName ? { username: storedState.selectedPlayerName } : {}), ...(storedState?.selectedFetchedAt ? { fetchedAt: storedState.selectedFetchedAt } : {}), waitingForUsername: storedState?.waitingForUsername ?? false };
      const linked = this.players?.links.getByDiscordUser(input.userId);
      const selected: PlayerSelection | undefined = state.selectedId && state.username ? { id: state.selectedId, username: state.username, fetchedAt: state.fetchedAt ?? '' }
        : linked ? { id: linked.playerId, username: linked.username, fetchedAt: linked.linkedAt } : undefined;
      const tools = createAgentTools({ chunks: this.chunks, ...(this.players ? { api: this.players.api } : {}), selected,
        setSelected: (player) => { state.selectedId = player.id; state.username = player.username; state.fetchedAt = player.fetchedAt; state.waitingForUsername = false; state.lastLookup = 'found'; this.messages.setAssistantContext(scopeId, { selectedPlayerId: player.id, selectedPlayerName: player.username, selectedFetchedAt: player.fetchedAt, waitingForUsername: false, updatedAt: new Date().toISOString() }); },
        setWaitingForUsername: () => { state.waitingForUsername = true; this.messages.setAssistantContext(scopeId, { ...(state.selectedId ? { selectedPlayerId: state.selectedId } : {}), ...(state.username ? { selectedPlayerName: state.username } : {}), ...(state.fetchedAt ? { selectedFetchedAt: state.fetchedAt } : {}), waitingForUsername: true, updatedAt: new Date().toISOString() }); },
        onPlayerSnapshot: (playerId, snapshot: PlayerSnapshot) => {
          if (linked?.playerId !== playerId) return undefined;
          const stage = selectOnboardingStage(snapshot);
          this.players!.links.updateOnboarding(playerId, stage);
          return { stage, state: this.players!.links.getOnboarding(playerId), mentorBrief };
        }, ...(this.apiReference ? { apiReference: this.apiReference } : {}) });
      const playerContext = selected || state.waitingForUsername ? JSON.stringify({ selectedPlayer: selected?.username, selectedFetchedAt: selected?.fetchedAt, waitingForUsername: state.waitingForUsername, lastLookup: state.lastLookup ?? (selected ? 'legacy-link' : undefined), source: 'temporary conversation selection' }) : undefined;
      stage = 'provider_generation';
      const answer = await this.provider.answer({ question: input.question, context: [], history, ...(playerContext ? { playerContext } : {}), tools });
      if (state.selectedId || state.waitingForUsername) this.messages.setAssistantContext(scopeId, { ...(state.selectedId ? { selectedPlayerId: state.selectedId } : {}), ...(state.username ? { selectedPlayerName: state.username } : {}), ...(state.fetchedAt ? { selectedFetchedAt: state.fetchedAt } : {}), waitingForUsername: state.waitingForUsername, updatedAt: new Date().toISOString() });
      return this.persistAnswer(input, history, answer);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      logger.error('Assistant pipeline failed', { stage, guildId: input.guildId, userId: input.userId, conversationId: input.conversationId, error: failure.message, stack: failure.stack, cause: failure.cause instanceof Error ? failure.cause.stack ?? failure.cause.message : undefined });
      throw error;
    }
  }

  private persistAnswer(input: AskInput, history: { role: 'user' | 'model'; content: string }[], answer: string): string {
    const now = new Date().toISOString();
    if (input.channelId) {
      const historyScope = JSON.stringify([input.channelId, input.conversationId ?? null]);
      this.messages.appendForScope({ guildId: input.guildId, userId: input.userId, role: 'user', content: input.question, createdAt: now }, historyScope);
      this.messages.appendForScope({ guildId: input.guildId, userId: input.userId, role: 'model', content: answer, createdAt: now }, historyScope);
    } else {
        this.messages.appendForUser({ guildId: input.guildId, userId: input.userId, role: 'user', content: input.question, createdAt: now });
        this.messages.appendForUser({ guildId: input.guildId, userId: input.userId, role: 'model', content: answer, createdAt: now });
    }
    void history;
    return answer;
  }
}
