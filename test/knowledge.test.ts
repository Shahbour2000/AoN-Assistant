import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { Bm25Index } from '../src/knowledge/bm25.js';
import { chunkMarkdown, parseFrontMatter } from '../src/knowledge/chunker.js';
import { KnowledgeBase } from '../src/knowledge/index.js';
import { stemArabic, tokenize } from '../src/knowledge/text.js';
import type { Embedder } from '../src/llm/types.js';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'aon-kb-'));

/** Deterministic stand-in for a real embedding model (hashed character trigrams). It tests the hybrid plumbing, NOT semantic quality. */
class TrigramEmbedder implements Embedder {
  readonly id = 'fake:trigram';
  calls = 0;
  texts: string[] = [];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    this.texts.push(...texts);
    return texts.map((text) => { const v = new Array<number>(256).fill(0); const t = ` ${tokenize(text).join(' ')} `; for (let i = 0; i < t.length - 2; i++) { let h = 0; for (const c of t.slice(i, i + 3)) h = (h * 31 + c.charCodeAt(0)) % 256; v[h]! += 1; } return v; });
  }
}

test('Arabic morphology: definite article, plural, taa marbuta and dialect spelling collapse to one term', () => {
  const forms = ['الشركات', 'شركة', 'شركات', 'للشركات', 'الشركه', 'بالشركات'];
  const stems = new Set(forms.map((f) => tokenize(f)[0]));
  assert.equal(stems.size, 1, [...stems].join(','));
  assert.equal(stemArabic('ذهب'), 'ذهب');
  assert.deepEqual(tokenize('Companies and the 3 workers'), ['company', '3', 'worker']);
});

test('chunker keeps heading breadcrumbs, never splits table rows, and repeats the table header when it must split', () => {
  const rows = Array.from({ length: 60 }, (_, i) => `| Item ${i} | ${i * 10} | ${i * 5} |`).join('\n');
  const md = `# Doc\n\n## Costs\n\nIntro text.\n\n| name | steel | concrete |\n|---|---:|---:|\n${rows}\n\n### Notes\nAfter table.`;
  const chunks = chunkMarkdown('doc.md', md, { targetChars: 500, maxChars: 900 });
  assert.ok(chunks.length > 2);
  assert.ok(chunks.every((c) => c.heading.startsWith('Doc')));
  assert.ok(chunks.some((c) => c.heading === 'Doc > Costs > Notes' && c.content.includes('After table')));
  const tableChunks = chunks.filter((c) => c.content.includes('| Item'));
  for (const c of tableChunks) {
    assert.ok(c.content.includes('| name | steel | concrete |'), 'each table slice carries the header');
    for (const line of c.content.split('\n').filter((l) => l.startsWith('| Item'))) assert.match(line, /\| Item \d+ \| \d+ \| \d+ \|$/u);
  }
  assert.equal(new Set(chunks.map((c) => c.id)).size, chunks.length);
});

test('front matter sets a ranking weight and is not indexed as content', () => {
  const parsed = parseFrontMatter('---\nretrieval_weight: 0.4\n---\n# T\nbody');
  assert.equal(parsed.meta.retrieval_weight, '0.4');
  const chunks = chunkMarkdown('g.md', '---\nretrieval_weight: 0.4\n---\n# Glossary\nterm');
  assert.equal(chunks[0]?.weight, 0.4);
  assert.ok(!chunks[0]!.content.includes('retrieval_weight'));
});

test('BM25 ranks the right section first and finds nothing for unrelated queries', () => {
  const docs = [{ heading: 'Economy', content: 'gold wages jobs work production points' }, { heading: 'War', content: 'battle damage weapons armor' }, { heading: 'Politics', content: 'president law election party' }];
  const index = new Bm25Index(docs);
  assert.equal(index.search('how do wages work')[0]?.index, 0);
  assert.equal(index.search('weapon damage')[0]?.index, 1);
  assert.deepEqual(index.search('quantum chromodynamics'), []);
});

test('knowledge base: recursive discovery, hot-reload of new files, README ignored, cache avoids re-embedding', async () => {
  const dir = await tmp();
  const cache = path.join(dir, '.cache', 'v.json');
  try {
    await mkdir(path.join(dir, 'sub'));
    await writeFile(path.join(dir, 'README.md'), '# Setup\nignore me please', 'utf8');
    await writeFile(path.join(dir, 'sub', 'a.md'), '# الاقتصاد\n\n## الأجور\nتُدفع الأجور بالذهب لكل نقطة إنتاج.', 'utf8');
    const embedder = new TrigramEmbedder();
    let now = 1_000_000;
    const kb = await KnowledgeBase.create({ dir, embedder, cacheFile: cache, now: () => now, refreshSeconds: 1 });
    assert.deepEqual(kb.documents, ['sub/a.md']);
    assert.equal(kb.semanticReady, true);
    const first = await kb.search(['كم الأجور بالذهب']);
    assert.equal(first.mode, 'hybrid');
    assert.equal(first.hits[0]?.source, 'sub/a.md');

    // a document added later is discovered without code changes or restart
    await writeFile(path.join(dir, 'b.md'), '# War\n\nDamage is computed from attack minus defense.', 'utf8');
    now += 5000;
    await kb.search(['x']);               // triggers the background refresh
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.deepEqual(kb.documents.sort(), ['b.md', 'sub/a.md']);
    assert.equal((await kb.search(['damage attack defense'])).hits[0]?.source, 'b.md');

    // restart: all vectors come from the cache, only new/changed chunks would be embedded
    const second = new TrigramEmbedder();
    const kb2 = await KnowledgeBase.create({ dir, embedder: second, cacheFile: cache });
    assert.equal(kb2.semanticReady, true);
    assert.equal(second.texts.length, 0, 'no document chunk was re-embedded');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('embedding outage degrades to keyword search instead of failing', async () => {
  const dir = await tmp();
  try {
    await writeFile(path.join(dir, 'a.md'), '# Skills\n\nSkills can only be increased with points.', 'utf8');
    const broken: Embedder = { id: 'broken', embed: async () => { throw new Error('quota'); } };
    const kb = await KnowledgeBase.create({ dir, embedder: broken });
    assert.equal(kb.semanticReady, false);
    const result = await kb.search(['skills points']);
    assert.equal(result.mode, 'keyword');
    assert.equal(result.hits[0]?.source, 'a.md');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('outline lists every document with its main sections within the size budget', async () => {
  const kb = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
  const outline = kb.outline(3500);
  for (const file of ['01-basics.md', '02-economy.md', '03-war.md', '04-politics.md', '05-community.md']) assert.ok(outline.includes(file), file);
  assert.ok(outline.length <= 3600);
});

// English-only questions against the Arabic/English wiki. Keyword mode bridges common terms through the glossary
// (knowledge/00-glossary.md is parsed in both directions), so these run offline and must pass.
const EN_ONLY: Array<{ name: string; queries: string[]; expect: RegExp }> = [
  { name: 'company founding cost', queries: ['company founding cost steel concrete'], expect: /الشركة 3 \| 60 \| 60/u },
  { name: 'skill points per level', queries: ['how many skill points do I get per level'], expect: /4 skill points and 5 gold/u },
  { name: 'skills reset cost', queries: ['how much does it cost to reset my skills'], expect: /0\.5 gold per skill point/u },
];
for (const item of EN_ONLY) {
  test(`real wiki retrieval, English-only, keyword mode: ${item.name}`, async () => {
    const kb = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
    const result = await kb.search(item.queries, { limit: 5 });
    assert.ok(result.hits.some((hit) => item.expect.test(hit.content)), `not in top 5: ${result.hits.map((h) => h.heading).join(' | ')}`);
  });
}

// English-only questions whose words have no glossary bridge need the real embedder. This test runs for real whenever Cloudflare
// credentials are in the environment (npm run eval:retrieval prints the full table); without them it is reported as TODO, not skipped.
const hasCloudflare = Boolean(process.env.CLOUDFLARE_ACCOUNT_ID?.trim() && process.env.CLOUDFLARE_API_TOKEN?.trim());
test('real wiki retrieval, English-only, hybrid with the Cloudflare embedder', { todo: hasCloudflare ? false : 'needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN; run `npm run eval:retrieval` where they are set', timeout: 180_000 }, async () => {
  const { buildEmbedder } = await import('../src/llm/presets.js');
  const embedder = buildEmbedder(process.env);
  assert.ok(embedder, 'embedder should be configured');
  const dir = await tmp();
  try {
    const kb = await KnowledgeBase.create({ dir: path.resolve('knowledge'), embedder, cacheFile: path.join(dir, 'embeddings.json') });
    assert.ok(kb.semanticReady, 'embeddings should initialise');
    for (const [queries, expect] of [[['what currency are wages paid in'], /الذهب هو العملة الوحيدة/u], [['how is damage calculated in a battle'], /الهجوم:\*\*/u]] as const) {
      const result = await kb.search([...queries], { limit: 5 });
      assert.ok(result.hits.some((hit) => expect.test(hit.content)), `${queries[0]} -> ${result.hits.map((h) => h.heading).join(' | ')}`);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ------------------------------------------------------------------ retrieval evaluation on the REAL wiki (keyword mode)
// Queries are what the agent is instructed to write (formal Arabic + English). The expectation is a distinctive fact that must be
// inside one of the top-5 passages. This measures the BM25 half of the system only; embeddings add recall on top of it.
const REAL_QUERIES: Array<{ name: string; queries: string[]; expectInTop5: RegExp }> = [
  { name: 'third company founding cost (AR)', queries: ['تكلفة تأسيس الشركة الثالثة الفولاذ الخرسانة', 'company 3 founding cost steel concrete'], expectInTop5: /الشركة 3 \| 60 \| 60/u },
  { name: 'new player first steps', queries: ['first steps new player starting inventory', 'بداية اللاعب الجديد'], expectInTop5: /A new player starts with/u },
  { name: 'wages in gold', queries: ['الأجور بالذهب نقطة إنتاج', 'how to earn gold wages'], expectInTop5: /الذهب هو العملة الوحيدة/u },
  { name: 'damage calculation', queries: ['حساب الضرر في المعركة', 'damage calculation order'], expectInTop5: /الهجوم:\*\*/u },
  { name: 'skills reset', queries: ['skills reset increase points', 'إعادة ضبط المهارات'], expectInTop5: /Skills can only be increased/u },
];
for (const item of REAL_QUERIES) {
  test(`real wiki retrieval: ${item.name}`, async () => {
    const kb = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
    const result = await kb.search(item.queries, { limit: 5 });
    assert.ok(result.hits.some((hit) => item.expectInTop5.test(hit.content)), `none of the top-5 passages matched ${item.expectInTop5}; got: ${result.hits.map((h) => h.heading).join(' | ')}`);
  });
}

test('a question about a mechanic that is not in the wiki yields no confident hit', async () => {
  const kb = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
  const result = await kb.search(['نظام الطيران الفضائي والصواريخ العابرة للقارات', 'spaceship launch intercontinental ballistic missile']);
  assert.ok(result.hits.length === 0 || result.confidence === 'low', `confidence=${result.confidence}, top=${result.hits[0]?.heading}`);
});
