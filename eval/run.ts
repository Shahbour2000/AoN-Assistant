/**
 * Live evaluation runner.   npm run eval            (all scenarios)
 *                           npm run eval -- beginner  (only ids/categories containing "beginner")
 *
 * REQUIRES: a configured LLM provider key (see .env.example) and — for `api: 'live'` scenarios — internet access to
 * https://app.ageofnations.world. It calls the real model, so it consumes free-tier quota (about 2–5 model calls per turn).
 * Nothing here runs in `npm test`.
 */
import 'dotenv/config';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantService, AssistantRequestGate } from '../src/assistant/service.js';
import { AonApiClient, AonApiError } from '../src/aon-api/client.js';
import { openDatabase } from '../src/database/database.js';
import { MessageRepository } from '../src/database/repositories.js';
import { KnowledgeBase } from '../src/knowledge/index.js';
import { buildEmbedder, buildLlm } from '../src/llm/presets.js';
import type { ChatRequest, ChatResponse, LlmProvider } from '../src/llm/types.js';
import { SCENARIOS, isMostlyArabic, isMostlyEnglish, type ApiMode, type Scenario } from './scenarios.js';

const filter = process.argv.slice(2).filter((arg) => !arg.startsWith('-'));
const wanted = SCENARIOS.filter((s) => !filter.length || filter.some((f) => s.id.includes(f) || s.category.includes(f)));

function faultyApi(mode: ApiMode) {
  return {
    async getJson(requestPath: string): Promise<unknown> {
      if (mode === 'faulty-404') throw new AonApiError('not_found', 'Not found', 404);
      if (mode === 'faulty-timeout') throw new AonApiError('unavailable', 'The Age of Nations API timed out');
      if (mode === 'faulty-rate-limit') throw new AonApiError('rate_limit', 'Too many requests', 429, 30);
      if (/\/players\/by-name\//u.test(requestPath) || /^\/players\/[^/]+$/u.test(requestPath)) return { id: 'usr_000000000000', username: 'Ghostly' };
      if (/\/players\/[^/]+\/stats/u.test(requestPath)) return { id: 'usr_000000000000', username: 'Ghostly' }; // no damage field at all
      throw new AonApiError('not_found', 'Not found', 404);
    },
  };
}

async function main() {
  const { llm: realLlm, specs } = buildLlm(process.env, undefined, (m) => console.warn(`warn: ${m}`));
  const embedder = buildEmbedder(process.env);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'aon-eval-'));
  const knowledge = await KnowledgeBase.create({ dir: process.env.KNOWLEDGE_DIR ?? './knowledge', embedder, cacheFile: path.join(dir, 'embeddings.json') });
  console.log(`Model chain : ${specs.map((s) => `${s.provider}:${s.model}`).join(' → ')}`);
  console.log(`Knowledge   : ${knowledge.documents.length} documents, ${knowledge.chunkCount} chunks, search mode = ${knowledge.semanticReady ? 'hybrid (keyword + embeddings)' : 'keyword only (no embeddings available)'}`);
  console.log(`LIVE evaluation: real model${embedder ? ' + real embeddings' : ''}; game API is live except scenarios marked "faulty-*" (simulated faults).\n`);

  const results: Array<{ id: string; mode: string; ok: boolean; failures: string[]; review: string[] }> = [];
  const liveApi = new AonApiClient();
  for (const scenario of wanted) results.push(await runScenario(scenario, realLlm, knowledge, liveApi, dir));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== Summary: ${results.length - failed.length}/${results.length} scenarios passed automatic checks ===`);
  for (const r of failed) console.log(` FAIL ${r.id}: ${r.failures.join(' | ')}`);
  console.log('Scenarios with "REVIEW" notes need a human to read the answer: regexes cannot verify game facts.');
  await writeFile(path.join(dir, 'report.json'), JSON.stringify(results, null, 2));
  console.log(`Report: ${path.join(dir, 'report.json')}`);
  process.exitCode = failed.length ? 1 : 0;
}

async function runScenario(scenario: Scenario, realLlm: LlmProvider, knowledge: KnowledgeBase, liveApi: AonApiClient, dir: string) {
  const dbFile = path.join(dir, `${scenario.id}.sqlite`);
  const db = await openDatabase(dbFile);
  const called: string[] = [];
  let turnTools: string[] = [];
  // The LLM wrapper records which tools the MODEL requested, so checks reflect the model's routing decisions.
  const llm: LlmProvider = { id: realLlm.id, async chat(request: ChatRequest): Promise<ChatResponse> { const response = await realLlm.chat(request); for (const call of response.toolCalls) { called.push(call.name); turnTools.push(call.name); } return response; } };
  const api = scenario.api === 'none' ? undefined : scenario.api === 'live' ? liveApi : faultyApi(scenario.api);
  const service = new AssistantService({ llm, messages: new MessageRepository(db), knowledge, api, requestGate: new AssistantRequestGate(Date.now, 1000, 1000, 60_000), validation: 'basic' });
  const failures: string[] = [];
  const review: string[] = [];
  console.log(`▶ ${scenario.id}  [${scenario.category}, api=${scenario.api}${scenario.api.startsWith('faulty') ? ' (SIMULATED)' : ''}]`);
  for (const [index, turn] of scenario.turns.entries()) {
    turnTools = [];
    let answer: string;
    try { answer = await service.ask({ guildId: 'eval', userId: 'eval-user', question: turn.say, channelId: `eval-${scenario.id}`, conversationId: scenario.id }); }
    catch (error) { failures.push(`turn ${index + 1} threw: ${error instanceof Error ? error.message : String(error)}`); console.log(`  ✗ error: ${failures.at(-1)}`); break; }
    console.log(`  you: ${turn.say}\n  bot: ${answer.replace(/\n/gu, '\n       ')}\n  tools: ${turnTools.join(', ') || '(none)'}`);
    const e = turn.expect;
    if (e?.language === 'arabic' && !isMostlyArabic(answer)) failures.push(`turn ${index + 1}: expected an Arabic answer`);
    if (e?.language === 'english' && !isMostlyEnglish(answer)) failures.push(`turn ${index + 1}: expected an English answer`);
    for (const pattern of e?.match ?? []) if (!pattern.test(answer)) failures.push(`turn ${index + 1}: answer should match ${pattern}`);
    for (const pattern of e?.avoid ?? []) if (pattern.test(answer)) failures.push(`turn ${index + 1}: answer must not match ${pattern}`);
    for (const tool of e?.tools ?? []) if (!turnTools.includes(tool)) failures.push(`turn ${index + 1}: expected tool ${tool} to be called (called: ${turnTools.join(', ') || 'none'})`);
    for (const tool of e?.noTools ?? []) if (turnTools.includes(tool)) failures.push(`turn ${index + 1}: tool ${tool} must not be called`);
    if (turn.note) review.push(turn.note);
  }
  db.close();
  await rm(dbFile, { force: true });
  console.log(failures.length ? `  ✗ ${failures.join('\n  ✗ ')}` : '  ✓ automatic checks passed');
  if (review.length) console.log(`  REVIEW: ${review.join(' / ')}`);
  console.log('');
  return { id: scenario.id, mode: scenario.api, ok: failures.length === 0, failures, review };
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
