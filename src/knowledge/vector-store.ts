import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Tiny persistent vector store. A game wiki is hundreds to a few thousand chunks, for which an exact in-memory
 * cosine scan over Float32Arrays takes well under a millisecond per thousand vectors, so there is no need for a native
 * vector database (and therefore no extra install step). Vectors are cached on disk by chunk-hash + embedder id, so a
 * restart only embeds chunks that are new or changed.
 */
export class VectorStore {
  private readonly vectors = new Map<string, Float32Array>();
  private dirty = false;
  constructor(private readonly file: string | undefined, readonly embedderId: string) {}

  async load(): Promise<void> {
    if (!this.file) return;
    try {
      const parsed = JSON.parse(await readFile(this.file, 'utf8')) as { embedderId?: string; vectors?: Record<string, string> };
      if (parsed.embedderId !== this.embedderId || !parsed.vectors) return; // different model => old vectors are meaningless
      for (const [hash, encoded] of Object.entries(parsed.vectors)) this.vectors.set(hash, decode(encoded));
    } catch { /* no cache yet or unreadable: rebuild */ }
  }

  has(hash: string): boolean { return this.vectors.has(hash); }
  get(hash: string): Float32Array | undefined { return this.vectors.get(hash); }
  set(hash: string, vector: number[]): void { this.vectors.set(hash, normalize(vector)); this.dirty = true; }
  /** Drop vectors for chunks that no longer exist. */
  retain(hashes: Set<string>): void { for (const key of [...this.vectors.keys()]) if (!hashes.has(key)) { this.vectors.delete(key); this.dirty = true; } }

  async save(): Promise<void> {
    if (!this.file || !this.dirty) return;
    await mkdir(path.dirname(this.file), { recursive: true });
    const vectors: Record<string, string> = {};
    for (const [hash, vector] of this.vectors) vectors[hash] = encode(vector);
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ embedderId: this.embedderId, vectors }), 'utf8');
    await rename(temp, this.file);
    this.dirty = false;
  }
}

export function normalize(vector: number[]): Float32Array {
  const out = new Float32Array(vector.length);
  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < vector.length; i++) out[i] = vector[i]! / norm;
  return out;
}

export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
  return sum;
}

function encode(vector: Float32Array): string { return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength).toString('base64'); }
function decode(text: string): Float32Array {
  const buffer = Buffer.from(text, 'base64');
  return new Float32Array(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength));
}
