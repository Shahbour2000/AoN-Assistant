import { logger } from '../logging/logger.js';
import { estimateTokens } from '../llm/tokens.js';
import type { ChatMessage, LlmProvider } from '../llm/types.js';
import type { ConversationMessage } from '../database/repositories.js';

/** The slice of MessageRepository that conversation memory needs (kept narrow so it can be tested with a fake). */
export interface MemoryStore {
  findSessionId(guildId: string, userId: string, channelId?: string): string | undefined;
  list(sessionId: string, limit?: number): ConversationMessage[];
  listAfter(sessionId: string, afterOrdinal: number, limit?: number): ConversationMessage[];
  getSummary(sessionId: string): { summary: string; throughOrdinal: number } | undefined;
  setSummary(sessionId: string, summary: string, throughOrdinal: number): void;
}

export interface MemoryOptions {
  /** Token budget for verbatim recent history sent with every request. */
  historyTokens?: number;
  /** Summarise once this many un-summarised messages exist beyond the verbatim window. */
  summariseAfter?: number;
  /** Messages always kept verbatim after a summary is written. */
  keepRecent?: number;
}

export interface LoadedMemory { summary?: string; messages: ChatMessage[]; sessionId?: string; }

/**
 * Conversation memory = rolling summary of old turns + as many recent messages (whole messages, never cut mid-answer)
 * as fit the token budget. Memory is keyed by the private conversation, so users never see each other's history.
 */
export class ConversationMemory {
  private readonly running = new Set<string>();
  constructor(private readonly store: MemoryStore, private readonly options: MemoryOptions = {}) {}

  load(guildId: string, userId: string, channelId?: string): LoadedMemory {
    const sessionId = this.store.findSessionId(guildId, userId, channelId);
    if (!sessionId) return { messages: [] };
    const summary = this.store.getSummary(sessionId);
    const recent = summary ? this.store.listAfter(sessionId, summary.throughOrdinal, 60) : this.store.list(sessionId, 60);
    const budget = this.options.historyTokens ?? 3000;
    const picked: ChatMessage[] = [];
    let used = 0;
    for (let i = recent.length - 1; i >= 0; i--) {
      const message = recent[i]!;
      const cost = estimateTokens(message.content) + 4;
      if (used + cost > budget && picked.length >= 2) break;
      used += cost;
      picked.unshift({ role: message.role === 'model' ? 'assistant' : 'user', content: message.content });
    }
    while (picked.length && picked[0]!.role === 'assistant') picked.shift(); // some providers require the first turn to be a user turn
    return { ...(summary ? { summary: summary.summary } : {}), messages: picked, sessionId };
  }

  /** Summarise old turns in the background. Never throws; a failure just means we try again next turn. */
  async maybeSummarise(sessionId: string, llm: LlmProvider): Promise<boolean> {
    if (this.running.has(sessionId)) return false;
    const keepRecent = this.options.keepRecent ?? 8;
    const threshold = this.options.summariseAfter ?? 14;
    const existing = this.store.getSummary(sessionId);
    const pending = this.store.listAfter(sessionId, existing?.throughOrdinal ?? -1, 200);
    if (pending.length < keepRecent + threshold) return false;
    this.running.add(sessionId);
    try {
      const toFold = pending.slice(0, pending.length - keepRecent);
      const transcript = toFold.map((m) => `${m.role === 'user' ? 'Player' : 'Assistant'}: ${m.content.slice(0, 1200)}`).join('\n');
      const response = await llm.chat({
        messages: [
          { role: 'system', content: 'You maintain the running memory of a private conversation between a player and an Age of Nations assistant. Merge the previous memory with the new messages into ONE updated memory of at most 220 words, written in the language the player uses. Keep: the player\'s goals, experience level, preferences, decisions, player/country names and ids they mentioned, the topic being discussed, important facts or numbers the assistant stated (mark game facts as "from the wiki" or "from live data" if they were), and unresolved questions. Drop greetings and filler. Never add information that is not in the text. Output only the memory.' },
          { role: 'user', content: `Previous memory:\n${existing?.summary ?? '(none)'}\n\nNew messages:\n${transcript}` },
        ],
        maxTokens: 450, temperature: 0.1,
      });
      const summary = response.content.trim();
      if (!summary) return false;
      this.store.setSummary(sessionId, summary.slice(0, 2500), toFold[toFold.length - 1]!.ordinal);
      return true;
    } catch (error) {
      logger.warn('Conversation summarisation failed', { error: error instanceof Error ? error.message : String(error) });
      return false;
    } finally { this.running.delete(sessionId); }
  }
}
