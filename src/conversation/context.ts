export interface ConversationMessage { role: 'user' | 'model'; content: string; }

export class ConversationContext {
  private readonly messages: ConversationMessage[] = [];
  constructor(private readonly maxMessages = 20) {}
  add(message: ConversationMessage): void {
    this.messages.push(message);
    if (this.messages.length > this.maxMessages) this.messages.splice(0, this.messages.length - this.maxMessages);
  }
  getHistory(): readonly ConversationMessage[] { return this.messages; }
  clear(): void { this.messages.length = 0; }
}
