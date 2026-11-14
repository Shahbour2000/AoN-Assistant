/**
 * Cheap token estimate that does not need a tokenizer. It is deliberately a little pessimistic for
 * Arabic, which tokenizes at roughly 2 characters per token on most LLM vocabularies.
 */
export function estimateTokens(text: string): number {
  let arabic = 0;
  let other = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if (code >= 0x0600 && code <= 0x06ff) arabic++; else other++;
  }
  return Math.ceil(arabic / 2 + other / 3.6);
}

export function estimateMessagesTokens(messages: Array<{ content?: string | null }>): number {
  return messages.reduce((sum, message) => sum + 4 + estimateTokens(message.content ?? ''), 0);
}
