import { createHash } from 'node:crypto';

export interface KnowledgeChunk {
  /** Stable id: `<relative path>#<n>` */
  id: string;
  /** Relative path of the Markdown file inside the knowledge directory. */
  source: string;
  /** Heading breadcrumb, e.g. "Economy > Companies > Construction cost". */
  heading: string;
  /** Chunk body (without breadcrumb). */
  content: string;
  /** Text used for indexing and embedding: breadcrumb + body. */
  text: string;
  /** Ranking multiplier from the file's front matter (`retrieval_weight`), default 1. Lets helper documents such as glossaries rank below real content. */
  weight: number;
  /** Hash of `text`; used to cache embeddings so unchanged chunks are never re-embedded. */
  hash: string;
}

export interface ChunkOptions { targetChars?: number; maxChars?: number; }

interface Block { kind: 'table' | 'code' | 'text'; lines: string[]; }

function hash(text: string): string { return createHash('sha256').update(text).digest('hex').slice(0, 24); }

/** Split Markdown into heading-delimited sections and then into size-bounded chunks. Tables and code fences are never cut mid-row. */
/** Optional `---` front matter with simple `key: value` lines. Only `retrieval_weight` is used. */
export function parseFrontMatter(markdown: string): { meta: Record<string, string>; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(markdown);
  if (!match) return { meta: {}, body: markdown };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/u)) { const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/u.exec(line.trim()); if (m) meta[m[1]!] = m[2]!.trim(); }
  return { meta, body: markdown.slice(match[0].length) };
}

export function chunkMarkdown(source: string, rawMarkdown: string, options: ChunkOptions = {}): KnowledgeChunk[] {
  const { meta, body: markdown } = parseFrontMatter(rawMarkdown);
  const parsedWeight = Number(meta.retrieval_weight);
  const weight = Number.isFinite(parsedWeight) && parsedWeight > 0 && parsedWeight <= 2 ? parsedWeight : 1;
  const target = options.targetChars ?? 1000;
  const max = options.maxChars ?? 1700;
  const fileTitle = source.replace(/^.*\//u, '').replace(/\.md$/iu, '');
  const lines = markdown.replace(/^﻿/u, '').split(/\r?\n/u);
  const stack: Array<{ level: number; title: string }> = [];
  let docTitle = fileTitle;
  let section: string[] = [];
  let sectionPath = fileTitle;
  const chunks: KnowledgeChunk[] = [];
  let fenced = false;

  const flush = () => {
    const body = section.join('\n').trim();
    section = [];
    if (!body || !/[\p{L}\p{N}]/u.test(body)) return;
    for (const piece of splitSection(body, target, max)) {
      const text = `${sectionPath}\n${piece}`;
      chunks.push({ id: `${source}#${chunks.length}`, source, heading: sectionPath, content: piece, text, weight, hash: hash(text) });
    }
  };

  for (const line of lines) {
    if (/^\s*(```|~~~)/u.test(line)) fenced = !fenced;
    const match = fenced ? null : /^(#{1,6})\s+(.+?)\s*#*\s*$/u.exec(line);
    if (match) {
      flush();
      const level = match[1]!.length;
      const title = match[2]!.replace(/[*_`]/gu, '').trim();
      while (stack.length && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });
      if (level === 1 && docTitle === fileTitle) docTitle = title;
      sectionPath = stack.map((entry) => entry.title).join(' > ');
      // Documents without an H1 still get the document name as the root of the breadcrumb.
      if (stack[0]!.level !== 1 && docTitle !== title) sectionPath = `${docTitle} > ${sectionPath}`;
    } else section.push(line);
  }
  flush();
  return chunks;
}

function toBlocks(body: string): Block[] {
  const blocks: Block[] = [];
  let current: Block | undefined;
  let fenced = false;
  const push = () => { if (current && current.lines.some((l) => l.trim())) blocks.push(current); current = undefined; };
  for (const line of body.split('\n')) {
    if (/^\s*(```|~~~)/u.test(line)) {
      if (!fenced) { push(); current = { kind: 'code', lines: [line] }; fenced = true; } else { current!.lines.push(line); fenced = false; push(); }
      continue;
    }
    if (fenced) { current!.lines.push(line); continue; }
    const isTable = /^\s*\|.*\|\s*$/u.test(line);
    if (!line.trim()) { push(); continue; }
    const kind = isTable ? 'table' : 'text';
    if (!current || current.kind !== kind) { push(); current = { kind, lines: [] }; }
    current.lines.push(line);
  }
  push();
  return blocks;
}

function splitSection(body: string, target: number, max: number): string[] {
  const pieces: string[] = [];
  let buffer = '';
  const flushBuffer = () => { if (buffer.trim()) pieces.push(buffer.trim()); buffer = ''; };
  const add = (text: string) => {
    if (buffer && buffer.length + text.length + 2 > target) flushBuffer();
    buffer = buffer ? `${buffer}\n\n${text}` : text;
    if (buffer.length >= target) flushBuffer();
  };
  for (const block of toBlocks(body)) {
    const text = block.lines.join('\n');
    if (text.length <= max) { add(text); continue; }
    flushBuffer();
    if (block.kind === 'table') {
      // Repeat the header (first two lines: header + separator) in every slice so each slice is understandable alone.
      const header = block.lines.slice(0, 2).join('\n');
      const rows = block.lines.slice(2);
      let slice: string[] = [];
      let size = header.length;
      for (const row of rows) {
        if (slice.length && size + row.length + 1 > target) { pieces.push(`${header}\n${slice.join('\n')}`); slice = []; size = header.length; }
        slice.push(row); size += row.length + 1;
      }
      if (slice.length) pieces.push(`${header}\n${slice.join('\n')}`);
    } else if (block.kind === 'code') {
      pieces.push(...hardSplit(text, max));
    } else {
      // Split long prose on lines first (lists), then sentences, then characters.
      let part = '';
      for (const line of block.lines) {
        for (const unit of line.length > max ? hardSplit(line, max) : [line]) {
          if (part && part.length + unit.length + 1 > target) { pieces.push(part.trim()); part = ''; }
          part = part ? `${part}\n${unit}` : unit;
        }
      }
      if (part.trim()) pieces.push(part.trim());
    }
  }
  flushBuffer();
  return pieces;
}

function hardSplit(text: string, max: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf('؟ ', max), rest.lastIndexOf('\n', max), rest.lastIndexOf(' ', max));
    if (cut < max * 0.5) cut = max;
    out.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1);
  }
  if (rest.trim()) out.push(rest.trim());
  return out;
}
