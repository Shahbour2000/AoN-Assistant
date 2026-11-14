import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { logger } from '../logging/logger.js';
import type { Embedder } from '../llm/types.js';
import { Bm25Index } from './bm25.js';
import { chunkMarkdown, type ChunkOptions, type KnowledgeChunk } from './chunker.js';
import { tokenize } from './text.js';
import { dot, normalize, VectorStore } from './vector-store.js';

export type { KnowledgeChunk } from './chunker.js';
export { normalizeArabic } from './text.js';

export interface SearchHit { id: string; source: string; heading: string; content: string; score: number; via: Array<'keyword' | 'semantic'>; }
export interface SearchResult {
  hits: SearchHit[];
  /** A hint for the model, NOT a gate: how strongly the best passage matches the query. */
  confidence: 'high' | 'medium' | 'low' | 'none';
  mode: 'hybrid' | 'keyword';
}
export interface KnowledgeOptions {
  dir: string;
  embedder?: Embedder | undefined;
  /** Where to cache vectors. Omit to keep them in memory only. */
  cacheFile?: string | undefined;
  chunk?: ChunkOptions;
  /** Minimum seconds between checks for added/changed files. */
  refreshSeconds?: number;
  now?: () => number;
}

export async function markdownFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
  const files = await Promise.all(entries.map(async (entry) => {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(full);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [full] : [];
  }));
  return files.flat().sort();
}

/** `knowledge/README.md` is setup guidance for humans, not game knowledge. */
function isSetupReadme(root: string, file: string): boolean { return path.relative(root, file).toLowerCase() === 'readme.md'; }

const RRF_K = 60;

export class KnowledgeBase {
  private chunks: KnowledgeChunk[] = [];
  private bm25 = new Bm25Index([]);
  private tokenSets: Array<Set<string> | undefined> = [];
  private store: VectorStore | undefined;
  private signature = '';
  private lastCheck = 0;
  private reloading: Promise<void> | undefined;
  private readonly queryCache = new Map<string, Float32Array>();
  private embeddingsFailed = false;

  constructor(private readonly options: KnowledgeOptions) {
    if (options.embedder) this.store = new VectorStore(options.cacheFile, options.embedder.id);
  }

  static async create(options: KnowledgeOptions): Promise<KnowledgeBase> {
    const kb = new KnowledgeBase(options);
    await kb.store?.load();
    await kb.reload();
    return kb;
  }

  get chunkCount(): number { return this.chunks.length; }
  get documents(): string[] { return [...new Set(this.chunks.map((chunk) => chunk.source))]; }
  get semanticReady(): boolean { return Boolean(this.store && !this.embeddingsFailed && this.chunks.length > 0 && this.chunks.every((chunk) => this.store!.has(chunk.hash))); }

  async reload(): Promise<void> {
    const dir = this.options.dir;
    const files = (await markdownFiles(dir)).filter((file) => !isSetupReadme(dir, file));
    const parts: KnowledgeChunk[] = [];
    const signatureParts: string[] = [];
    for (const file of files) {
      const source = path.relative(dir, file).split(path.sep).join('/');
      const info = await stat(file);
      signatureParts.push(`${source}:${info.size}:${info.mtimeMs}`);
      parts.push(...chunkMarkdown(source, await readFile(file, 'utf8'), this.options.chunk));
    }
    this.chunks = parts;
    this.signature = signatureParts.join('|');
    this.lastCheck = (this.options.now ?? Date.now)();
    this.bm25 = new Bm25Index(parts);
    this.tokenSets = new Array(parts.length).fill(undefined);
    await this.embedMissing();
    logger.info('Knowledge loaded', { documents: files.length, chunks: parts.length, mode: this.semanticReady ? 'hybrid' : 'keyword', embedder: this.options.embedder?.id ?? 'none' });
  }

  private async embedMissing(): Promise<void> {
    const embedder = this.options.embedder;
    const store = this.store;
    if (!embedder || !store) return;
    store.retain(new Set(this.chunks.map((chunk) => chunk.hash)));
    const missing = this.chunks.filter((chunk) => !store.has(chunk.hash));
    this.embeddingsFailed = false;
    if (!missing.length) { await store.save(); return; }
    try {
      const batch = 32;
      for (let start = 0; start < missing.length; start += batch) {
        const slice = missing.slice(start, start + batch);
        const vectors = await embedder.embed(slice.map((chunk) => chunk.text), 'document');
        slice.forEach((chunk, i) => store.set(chunk.hash, vectors[i]!));
      }
    } catch (error) {
      this.embeddingsFailed = true;
      logger.warn('Embedding failed; knowledge search falls back to keyword-only until the next refresh', { error: error instanceof Error ? error.message : String(error) });
    }
    await store.save().catch((error) => logger.warn('Could not save embedding cache', { error: String(error) }));
  }

  /** Cheap check (throttled) for added/removed/edited Markdown files. Reloads in the background; searches keep using the previous index meanwhile. */
  private maybeRefresh(): void {
    const now = (this.options.now ?? Date.now)();
    if (this.reloading || now - this.lastCheck < (this.options.refreshSeconds ?? 30) * 1000) return;
    this.lastCheck = now;
    this.reloading = (async () => {
      const files = (await markdownFiles(this.options.dir)).filter((file) => !isSetupReadme(this.options.dir, file));
      const sig: string[] = [];
      for (const file of files) { const info = await stat(file); sig.push(`${path.relative(this.options.dir, file).split(path.sep).join('/')}:${info.size}:${info.mtimeMs}`); }
      const changed = sig.join('|') !== this.signature;
      // Retry failed embeddings on the next tick as well.
      if (changed || this.embeddingsFailed) await this.reload();
    })().catch((error) => logger.warn('Knowledge refresh failed', { error: error instanceof Error ? error.message : String(error) })).finally(() => { this.reloading = undefined; });
  }

  async search(queries: string[], options: { limit?: number } = {}): Promise<SearchResult> {
    this.maybeRefresh();
    const cleaned = [...new Set(queries.map((query) => query.trim()).filter(Boolean))].slice(0, 4);
    const limit = options.limit ?? 6;
    if (!cleaned.length || !this.chunks.length) return { hits: [], confidence: 'none', mode: 'keyword' };

    const scores = new Map<number, { fused: number; via: Set<'keyword' | 'semantic'>; lexTop: number }>();
    const bump = (index: number, rank: number, via: 'keyword' | 'semantic') => {
      const entry = scores.get(index) ?? { fused: 0, via: new Set(), lexTop: 0 };
      entry.fused += (1 / (RRF_K + rank + 1)) * this.chunks[index]!.weight;
      entry.via.add(via);
      scores.set(index, entry);
    };

    for (const query of cleaned) {
      const lexical = this.bm25.search(query, 24);
      const top = lexical[0]?.score ?? 0;
      lexical.filter((hit) => hit.score >= top * 0.3).forEach((hit, rank) => bump(hit.index, rank, 'keyword'));
    }

    let mode: SearchResult['mode'] = 'keyword';
    const embedder = this.options.embedder;
    const store = this.store;
    if (embedder && store && !this.embeddingsFailed) {
      try {
        const vectors = await this.embedQueries(cleaned);
        mode = 'hybrid';
        for (const vector of vectors) {
          const ranked: Array<{ index: number; sim: number }> = [];
          this.chunks.forEach((chunk, index) => { const v = store.get(chunk.hash); if (v) ranked.push({ index, sim: dot(vector, v) }); });
          ranked.sort((a, b) => b.sim - a.sim);
          const best = ranked[0]?.sim ?? 0;
          ranked.slice(0, 20).filter((item) => item.sim >= best - 0.07).forEach((item, rank) => bump(item.index, rank, 'semantic'));
        }
      } catch (error) {
        logger.warn('Query embedding failed; using keyword search only', { error: error instanceof Error ? error.message : String(error) });
      }
    }

    const ranked = [...scores].sort((a, b) => b[1].fused - a[1].fused || a[0] - b[0]);
    if (!ranked.length) return { hits: [], confidence: 'none', mode };
    const topFused = ranked[0]![1].fused;
    const selected = ranked.filter(([, entry]) => entry.fused >= topFused * 0.3).slice(0, limit);
    const hits: SearchHit[] = selected.map(([index, entry]) => {
      const chunk = this.chunks[index]!;
      return { id: chunk.id, source: chunk.source, heading: chunk.heading, content: chunk.content, score: Number(entry.fused.toFixed(5)), via: [...entry.via] };
    });

    const queryTerms = new Set(cleaned.flatMap((query) => tokenize(query)));
    const topIndex = selected[0]![0];
    const topTokens = (this.tokenSets[topIndex] ??= new Set(tokenize(`${this.chunks[topIndex]!.heading} ${this.chunks[topIndex]!.content}`)));
    const coverage = queryTerms.size ? [...queryTerms].filter((term) => topTokens.has(term)).length / queryTerms.size : 0;
    const agreement = selected[0]![1].via.size > 1;
    const confidence: SearchResult['confidence'] = (agreement && coverage >= 0.4) || coverage >= 0.7 ? 'high' : agreement || coverage >= 0.4 ? 'medium' : 'low';
    return { hits, confidence, mode };
  }

  private async embedQueries(queries: string[]): Promise<Float32Array[]> {
    const missing = queries.filter((query) => !this.queryCache.has(query));
    if (missing.length) {
      const vectors = await this.options.embedder!.embed(missing, 'query');
      missing.forEach((query, i) => {
        this.queryCache.set(query, normalize(vectors[i]!));
        if (this.queryCache.size > 300) this.queryCache.delete(this.queryCache.keys().next().value as string);
      });
    }
    return queries.map((query) => this.queryCache.get(query)!);
  }

  /**
   * A compact map of what the knowledge base contains (document titles and their main sections). It goes into the
   * system prompt so the model knows what exists and can write search queries using the wiki's own (Arabic) terms.
   */
  outline(maxChars = 3500): string {
    const bySource = new Map<string, string[]>();
    for (const chunk of this.chunks) {
      const parts = chunk.heading.split(' > ');
      const list = bySource.get(chunk.source) ?? [];
      const label = parts.slice(0, 2).join(' > ');
      if (!list.includes(label)) list.push(label);
      bySource.set(chunk.source, list);
    }
    const lines: string[] = [];
    let used = 0;
    const budgetPerDoc = Math.max(160, Math.floor(maxChars / Math.max(1, bySource.size)));
    for (const [source, labels] of bySource) {
      let line = `- ${source}: `;
      for (const label of labels) { if (line.length + label.length + 3 > budgetPerDoc) { line += '…'; break; } line += `${label}; `; }
      if (used + line.length > maxChars) break;
      lines.push(line.trim()); used += line.length + 1;
    }
    return lines.join('\n');
  }
}
