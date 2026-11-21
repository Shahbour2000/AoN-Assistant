/**
 * npm run eval:retrieval — runs the real wiki retrieval evaluation with your configured embedder (Cloudflare bge-m3) and ALSO in
 * keyword-only mode, so you can see exactly what the embeddings add. Needs CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN and internet
 * for the hybrid half; without them only the keyword half runs and the hybrid half is reported as "not tested".
 * It embeds the ~270 wiki chunks once (cached in data/embeddings.json, so later runs only embed the queries).
 */
import 'dotenv/config';
import path from 'node:path';
import { KnowledgeBase } from '../src/knowledge/index.js';
import { buildEmbedder } from '../src/llm/presets.js';

interface Case { name: string; queries: string[]; expect: RegExp }
export const CASES: Case[] = [
  { name: 'EN-only: third company founding cost', queries: ['company founding cost steel concrete'], expect: /الشركة 3 \| 60 \| 60/u },
  { name: 'EN-only: skill points per level', queries: ['how many skill points do I get per level'], expect: /4 skill points and 5 gold/u },
  { name: 'EN-only: reset skills cost', queries: ['how much does it cost to reset my skills'], expect: /0\.5 gold per skill point/u },
  { name: 'EN-only: wages currency', queries: ['what currency are wages paid in'], expect: /الذهب هو العملة الوحيدة/u },
  { name: 'EN-only: damage calculation', queries: ['how is damage calculated in a battle'], expect: /الهجوم:\*\*/u },
  { name: 'AR-only: third company founding cost', queries: ['تكلفة تأسيس الشركة الثالثة الفولاذ الخرسانة'], expect: /الشركة 3 \| 60 \| 60/u },
  { name: 'AR-only: skill points per level', queries: ['كم نقطة مهارة أحصل عليها كل مستوى'], expect: /4 skill points and 5 gold|4 نقاط/u },
  { name: 'AR-only: reset skills', queries: ['إعادة ضبط المهارات'], expect: /Skills can only be increased|0\.5 gold/u },
];

async function run(label: string, kb: KnowledgeBase): Promise<number> {
  let pass = 0;
  console.log(`\n--- ${label} (mode=${kb.semanticReady ? 'hybrid' : 'keyword'}) ---`);
  for (const item of CASES) {
    const result = await kb.search(item.queries, { limit: 5 });
    const rank = result.hits.findIndex((hit) => item.expect.test(hit.content));
    if (rank >= 0) pass++;
    console.log(`${rank >= 0 ? '✓' : '✗'} ${item.name.padEnd(42)} ${rank >= 0 ? `rank ${rank + 1}` : 'NOT in top 5'}  (confidence ${result.confidence})`);
  }
  console.log(`${pass}/${CASES.length} found in the top 5`);
  return pass;
}

async function main() {
  const dir = path.resolve('knowledge');
  const keyword = await run('keyword only (BM25 + glossary expansion)', await KnowledgeBase.create({ dir }));
  let embedder;
  try { embedder = buildEmbedder(process.env); } catch (error) { console.log(`\nHybrid half NOT TESTED: embedder config error: ${(error as Error).message}`); process.exitCode = 1; return; }
  if (!embedder) { console.log('\nHybrid half NOT TESTED: no embedder configured (set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN).'); if (keyword < CASES.length) process.exitCode = 1; return; }
  const kb = await KnowledgeBase.create({ dir, embedder, cacheFile: path.resolve('data', 'embeddings.json') });
  if (!kb.semanticReady) { console.log('\nHybrid half NOT TESTED: the embedder failed to initialise (quota or network); see the log above.'); process.exitCode = 1; return; }
  const hybrid = await run(`hybrid with ${embedder.id}`, kb);
  console.log(`\nSummary: keyword ${keyword}/${CASES.length}, hybrid ${hybrid}/${CASES.length}.`);
  if (hybrid < CASES.length) process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
