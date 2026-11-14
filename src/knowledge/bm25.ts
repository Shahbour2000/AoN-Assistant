import { tokenize } from './text.js';

export interface Bm25Hit { index: number; score: number; }

/** Inverted-index BM25. Built once per knowledge load; queries cost O(matching postings) instead of O(corpus). */
export class Bm25Index {
  private readonly postings = new Map<string, Array<[number, number]>>();
  private readonly lengths: number[] = [];
  private readonly avgLength: number;

  /** `heading` terms are counted `headingBoost` times so a section titled "Companies" outranks a passing mention. */
  constructor(docs: Array<{ heading: string; content: string }>, private readonly k1 = 1.4, private readonly b = 0.72, headingBoost = 3) {
    docs.forEach((doc, index) => {
      const counts = new Map<string, number>();
      for (const token of tokenize(doc.content)) counts.set(token, (counts.get(token) ?? 0) + 1);
      for (const token of tokenize(doc.heading)) counts.set(token, (counts.get(token) ?? 0) + headingBoost);
      let length = 0;
      for (const [term, tf] of counts) {
        length += tf;
        const list = this.postings.get(term);
        if (list) list.push([index, tf]); else this.postings.set(term, [[index, tf]]);
      }
      this.lengths.push(length);
    });
    this.avgLength = this.lengths.reduce((sum, value) => sum + value, 0) / Math.max(1, this.lengths.length);
  }

  get size(): number { return this.lengths.length; }

  search(query: string, limit = 20): Bm25Hit[] {
    const terms = [...new Set(tokenize(query))];
    const n = this.lengths.length;
    const scores = new Map<number, number>();
    for (const term of terms) {
      const list = this.postings.get(term);
      if (!list) continue;
      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const [doc, tf] of list) {
        const norm = this.k1 * (1 - this.b + this.b * (this.lengths[doc]! / this.avgLength));
        scores.set(doc, (scores.get(doc) ?? 0) + idf * ((tf * (this.k1 + 1)) / (tf + norm)));
      }
    }
    return [...scores].map(([index, score]) => ({ index, score })).sort((a, b) => b.score - a.score || a.index - b.index).slice(0, limit);
  }
}
