import { createHash } from 'node:crypto';

/**
 * Small in-memory cache of finished answers. The key is a hash of EVERYTHING the model would see (system prompt, conversation history,
 * the question, the wiki passages that were retrieved, the tools on offer), so an entry is only reused for a truly equivalent request:
 * the same question in the same conversation context with the same wiki evidence. A different user, a different history, a different
 * active player or an edited wiki produces a different key. Answers that used live game data or failed validation are never stored.
 */
export class AnswerCache<T> {
  private readonly entries = new Map<string, { value: T; expires: number }>();
  constructor(private readonly ttlMs = 6 * 3_600_000, private readonly maxEntries = 300, private readonly now: () => number = Date.now) {}

  static key(parts: unknown): string { return createHash('sha256').update(JSON.stringify(parts)).digest('hex'); }

  get(key: string): T | undefined {
    const hit = this.entries.get(key);
    if (!hit) return undefined;
    if (hit.expires <= this.now()) { this.entries.delete(key); return undefined; }
    this.entries.delete(key); this.entries.set(key, hit); // most recently used last
    return hit.value;
  }

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expires: this.now() + this.ttlMs });
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string);
  }

  get size(): number { return this.entries.size; }
}
