import type { MessageRepository } from '../database/repositories.js';
import type { AnswerProvider } from '../gemini/client.js';
import { retrieve, type KnowledgeChunk } from '../knowledge/retrieval.js';

export interface AskInput { guildId: string; userId: string; question: string; conversationId?: string; }

export class AssistantService {
  constructor(private readonly provider: AnswerProvider, private readonly messages: MessageRepository, private readonly chunks: KnowledgeChunk[]) {}
  async ask(input: AskInput): Promise<string> {
    const context = retrieve(this.chunks, input.question, 5);
    const history = input.conversationId ? this.messages.listForSession(input.conversationId, 20) : this.messages.listForUser(input.guildId, input.userId, 20);
    const answer = await this.provider.answer({ question: input.question, context, history });
    const now = new Date().toISOString();
    if (input.conversationId) {
      this.messages.appendToSession(input.conversationId, 'user', input.question, now);
      this.messages.appendToSession(input.conversationId, 'model', answer);
    } else {
      this.messages.appendForUser({ guildId: input.guildId, userId: input.userId, role: 'user', content: input.question, createdAt: now });
      this.messages.appendForUser({ guildId: input.guildId, userId: input.userId, role: 'model', content: answer, createdAt: new Date().toISOString() });
    }
    return answer;
  }
}
