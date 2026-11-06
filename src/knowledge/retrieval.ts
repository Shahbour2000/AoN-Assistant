import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

export interface KnowledgeChunk { source: string; heading: string; content: string; }
export interface KnowledgeOptions { maxChunkCharacters?: number; overlapCharacters?: number; }

export async function loadKnowledge(root: string, options: KnowledgeOptions = {}): Promise<KnowledgeChunk[]> {
  const max = options.maxChunkCharacters ?? 1200;
  const overlap = options.overlapCharacters ?? 120;
  if (!Number.isInteger(max) || max < 100 || !Number.isInteger(overlap) || overlap < 0 || overlap >= max) throw new Error('Invalid knowledge chunk sizing options');
  const files = await markdownFiles(root);
  const chunks: KnowledgeChunk[] = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const source = path.relative(root, file).replaceAll(path.sep, '/');
    let heading = path.basename(file, path.extname(file));
    let section: string[] = [];
    const flush = () => {
      const content = section.join('\n').trim();
      if (content) chunks.push(...splitChunk(content, source, heading, max, overlap));
      section = [];
    };
    for (const line of text.split(/\r?\n/)) {
      const match = /^(#{1,6})\s+(.+)$/.exec(line);
      if (match) { flush(); heading = match[2]!.trim(); }
      else section.push(line);
    }
    flush();
  }
  return chunks;
}

export async function markdownFiles(directory: string): Promise<string[]> {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files = await Promise.all(entries.map(async (entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return markdownFiles(fullPath);
    return entry.isFile() && entry.name.toLowerCase().endsWith('.md') ? [fullPath] : [];
  }));
  return files.flat().sort();
}

export function retrieve(chunks: KnowledgeChunk[], question: string, limit = 5): KnowledgeChunk[] {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Retrieval limit must be a positive integer');
  const terms = tokenize(question);
  if (terms.size === 0) return [];
  return chunks.map((chunk, index) => {
    const words = tokenize(`${chunk.heading} ${chunk.content}`);
    let score = 0;
    for (const term of terms) if (words.has(term)) score += term.length > 2 ? 2 : 1;
    return { chunk, score, index };
  }).filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, limit).map(({ chunk }) => chunk);
}

export function normalizeArabic(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('und')
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ؤ/gu, 'و').replace(/ئ/gu, 'ي').replace(/ة/gu, 'ه');
}

function splitChunk(content: string, source: string, heading: string, max: number, overlap: number): KnowledgeChunk[] {
  if (content.length <= max) return [{ source, heading, content }];
  const paragraphs = content.split(/\n\s*\n/u).map((part) => part.trim()).filter(Boolean);
  const chunks: KnowledgeChunk[] = [];
  let current = '';
  const push = () => { if (current.trim()) chunks.push({ source, heading, content: current.trim() }); };
  for (const paragraph of paragraphs.length ? paragraphs : [content]) {
    if (paragraph.length > max) {
      if (current) { push(); current = ''; }
      let start = 0;
      while (start < paragraph.length) {
        const end = Math.min(start + max, paragraph.length);
        let boundary = end;
        if (end < paragraph.length) {
          const candidate = paragraph.lastIndexOf(' ', end);
          if (candidate > start + max * 0.6) boundary = candidate;
        }
        chunks.push({ source, heading, content: paragraph.slice(start, boundary).trim() });
        if (boundary >= paragraph.length) break;
        start = Math.max(start + 1, boundary - overlap);
      }
    } else if (!current) current = paragraph;
    else if (current.length + paragraph.length + 2 <= max) current += `\n\n${paragraph}`;
    else { push(); const tail = current.slice(-overlap); current = tail ? `${tail}\n\n${paragraph}` : paragraph; }
  }
  push();
  return chunks;
}

function tokenize(text: string): Set<string> {
  return new Set(normalizeArabic(text).match(/[\p{L}\p{N}]{2,}/gu) ?? []);
}
