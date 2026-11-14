import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { calculate, formatNumber } from '../src/agent/calc.js';
import { addGold, compact, toGold } from '../src/agent/compact.js';
import { runAgent } from '../src/agent/loop.js';
import { buildSystemPrompt } from '../src/agent/prompt.js';
import { createTools, type GameApi, type ToolContext } from '../src/agent/tools/index.js';
import { evidenceNumbers, extractNumbers, validateDeterministic, verifyWithLlm, type EvidenceEntry } from '../src/agent/validator.js';
import { KnowledgeBase } from '../src/knowledge/index.js';
import { call, ScriptedLlm } from './helpers/scripted-llm.js';

// ---------------------------------------------------------------- calculator
test('calculator is exact, safe (no eval) and understands Arabic digits and percentages', () => {
  assert.equal(calculate('20+40+60'), 120);
  assert.equal(calculate('(60+80)*2'), 280);
  assert.equal(calculate('٢٠ + ٤٠'), 60);
  assert.equal(calculate('2^3^1'), 8);
  assert.equal(calculate('max(3, 9) + sqrt(16)'), 13);
  assert.equal(calculate('50% * 200'), 100);
  assert.equal(formatNumber(0.1 + 0.2), '0.3');
  for (const bad of ['process.exit()', '1/0', '2+', 'constructor', '(1', '']) assert.throws(() => calculate(bad), bad);
});

// ---------------------------------------------------------------- compaction & money
test('money strings convert from 1/10,000 gold exactly; compaction marks truncated lists', () => {
  assert.equal(toGold('12345'), '1.2345');
  assert.equal(toGold('4000000'), '400');
  assert.equal(toGold('5'), '0.0005');
  assert.equal(toGold('-15000'), '-1.5');
  assert.equal(toGold('abc'), undefined);
  assert.deepEqual(addGold({ treasury: { money: '22943306' } }, new Set(['money'])), { treasury: { money: '22943306', moneyGold: '2294.3306' } });
  const big = compact({ rows: Array.from({ length: 100 }, (_, i) => ({ i, name: `n${i}` })), avatarUrl: 'x', empty: null }, 400) as { rows: unknown[]; avatarUrl?: string };
  assert.ok(JSON.stringify(big).length <= 600);
  assert.ok(String(big.rows.at(-1)).includes('more'));
  assert.equal(big.avatarUrl, undefined);
});

// ---------------------------------------------------------------- fake game API
type Reply = unknown | Error;
class FakeApi implements GameApi {
  paths: string[] = [];
  constructor(private readonly routes: Record<string, Reply>) {}
  async getJson(p: string): Promise<unknown> {
    this.paths.push(p);
    const hit = this.routes[p];
    if (hit === undefined) throw Object.assign(new Error('404'), { kind: 'not_found' });
    if (hit instanceof Error) throw hit;
    return hit;
  }
}
const apiError = (kind: string) => Object.assign(new Error(kind), { kind });
const PLAYER = { id: 'usr_abc123def456', username: 'Egyptian', level: 47, xp: 10, xpNextLevel: 99, prestige: 1, rank: { code: 'major' }, countryId: 'eg', damage: { total: '9876543', day: '10', week: '70', month: '300' }, skills: [{ code: 'attack', level: 12, maxLevel: 40 }], economy: { companies: 3, lifetime: { wagesEarned: '12345678' } }, avatarUrl: 'http://x' };
const STATS = { damage: { all: '9876543', month: '300', week: '70', day: '10' }, work: { all: '55' } };
const EG = { id: 'eg', name: 'Egypt', citizens: { total: 639, active: 212 }, development: 40, treasury: { money: '22943306' }, citizenshipFee: '4000000', coreRegions: [{ controlledBy: 'eg' }, { controlledBy: 'x' }] };

function ctx(api: GameApi | undefined, knowledge?: KnowledgeBase): ToolContext & { active?: { id: string; username: string; fetchedAt: string } } {
  const state: { active?: { id: string; username: string; fetchedAt: string } } = {};
  return { knowledge, api, getActivePlayer: () => state.active, setActivePlayer: (p: unknown) => { state.active = p as never; }, now: () => 0, get active() { return state.active; } } as never;
}
const tool = (name: string, api?: GameApi, knowledge?: KnowledgeBase) => createTools({ api, knowledge }).find((t) => t.name === name)!;

test('find_player resolves via the API, converts money, sets the active player, and drops noise', async () => {
  const api = new FakeApi({ '/players/by-name/Egyptian': PLAYER });
  const c = ctx(api);
  const result = await tool('find_player', api).execute({ username: 'Egyptian' }, c) as any;
  assert.equal(result.status, 'ok');
  assert.equal(c.active?.id, 'usr_abc123def456');
  assert.equal(result.player.economy.lifetime.wagesEarnedGold, '1234.5678');
  assert.equal(result.player.avatarUrl, undefined);
  assert.equal(result.player.skills.attack, '12/40');
});

test('invalid player name: 404 is "not_found" with real similar players from search; nothing is invented', async () => {
  const api = new FakeApi({ '/search?q=Nobody123': { players: [{ id: 'usr_zzzzzz111111', username: 'Nobody12', countryId: 'eg', level: 3 }], countries: [] } });
  const result = await tool('find_player', api).execute({ username: 'Nobody123' }, ctx(api)) as any;
  assert.equal(result.status, 'not_found');
  assert.equal(result.similarPlayers[0].username, 'Nobody12');
});

test('API timeout / 5xx / 429 / malformed are reported as temporary, never as not_found', async () => {
  for (const [kind, status] of [['unavailable', 'unavailable'], ['rate_limit', 'rate_limited'], ['invalid_response', 'unavailable']] as const) {
    const api = new FakeApi({ '/players/by-name/Egyptian': apiError(kind) });
    const result = await tool('find_player', api).execute({ username: 'Egyptian' }, ctx(api)) as any;
    assert.equal(result.status, status, kind);
    assert.match(result.note, /NOT evidence|temporar|malformed/u);
  }
  const malformed = new FakeApi({ '/players/by-name/Egyptian': { nope: true } });
  const result = await tool('find_player', malformed).execute({ username: 'Egyptian' }, ctx(malformed)) as any;
  assert.equal(result.status, 'unavailable');
  assert.equal(result.kind, 'invalid_response');
});

test('follow-up uses the active player; partial results keep what succeeded; missing field is simply absent', async () => {
  const api = new FakeApi({ '/players/by-name/Egyptian': PLAYER, '/players/usr_abc123def456/stats': STATS, '/players/usr_abc123def456/companies?limit=15&sort=invested': apiError('unavailable') });
  const c = ctx(api);
  await tool('find_player', api).execute({ username: 'Egyptian' }, c);
  const result = await tool('get_player_data', api).execute({ include: ['stats', 'companies'] }, c) as any;
  assert.equal(result.status, 'partial');
  assert.equal(result.data.stats.damage.all, '9876543');
  assert.equal(result.data.stats.work.all, '55');
  assert.equal(result.data.stats.trade, undefined);
  assert.equal(result.unavailable.companies.status, 'unavailable');
  const none = await tool('get_player_data', api).execute({}, ctx(api)) as any;
  assert.equal(none.status, 'needs_input');
});

test('country tool: name resolves through search (country, not player), shows population, converts money, handles ambiguity', async () => {
  const api = new FakeApi({ '/search?q=Egypt': { players: [{ id: 'usr_egyptfan0001', username: 'Egypt' }], countries: [{ id: 'eg', name: 'Egypt' }] }, '/countries/eg': EG });
  const result = await tool('get_country', api).execute({ country: 'Egypt' }, ctx(api)) as any;
  assert.equal(result.status, 'ok');
  assert.equal(result.country, 'eg');
  assert.equal(result.data.citizens.total, 639);
  assert.equal(result.data.treasury.moneyGold, '2294.3306');
  assert.equal(result.data.coreRegionsHeld, 1);
  const ambiguous = new FakeApi({ '/search?q=Congo': { countries: [{ id: 'cd', name: 'DR Congo' }, { id: 'cg', name: 'Republic of the Congo' }] } });
  assert.equal((await tool('get_country', ambiguous).execute({ country: 'Congo' }, ctx(ambiguous)) as any).status, 'needs_input');
  const missing = new FakeApi({ '/search?q=Atlantis': { players: [], countries: [] } });
  assert.equal((await tool('get_country', missing).execute({ country: 'Atlantis' }, ctx(missing)) as any).status, 'not_found');
});

test('tool argument validation rejects bad input instead of calling the API', async () => {
  const api = new FakeApi({});
  await assert.rejects(() => tool('get_rankings', api).execute({ board: 'nonsense' }, ctx(api)), /one of/u);
  await assert.rejects(() => tool('get_company', api).execute({ companyId: '../../etc' }, ctx(api)), /not valid/u);
  await assert.rejects(() => tool('find_player', api).execute({ username: '' }, ctx(api)), /required/u);
  assert.deepEqual(api.paths, []);
});

test('game tools are not offered when no API is configured; knowledge tool only with a knowledge base', () => {
  assert.deepEqual(createTools({}).map((t) => t.name), ['calculate']);
});

// ---------------------------------------------------------------- validator
const ev = (tool: string, status: string, text: string, kind: EvidenceEntry['kind'] = 'game'): EvidenceEntry => ({ tool, kind, args: '{}', status, text });

test('number extraction handles Arabic digits, separators and million/مليون scaling', () => {
  assert.deepEqual(extractNumbers('٦٠ و 1,234 و 17.9 مليون').map((n) => n.values), [[60], [1234], [17.9, 17_900_000]]);
});

test('validator flags numbers that no tool result supports, but not numbers from tools, the question or calculations', () => {
  const evidence = [ev('search_knowledge', 'ok', 'الشركة 3 | 60 | 60', 'knowledge'), ev('calculate', 'ok', '{"expression":"60+60","result":"120"}', 'utility')];
  const base = { question: 'كام حديد للشركة التالتة؟', history: '', evidence };
  assert.deepEqual(validateDeterministic({ ...base, answer: 'محتاج 60 فولاذ و60 خرسانة، يعني 120 إجمالًا.' }), []);
  const bad = validateDeterministic({ ...base, answer: 'محتاج 75 فولاذ و 60 خرسانة.' });
  assert.equal(bad[0]?.code, 'ungrounded_numbers');
  assert.match(bad[0]!.message, /75/u);
  assert.deepEqual(validateDeterministic({ question: 'what is the capital of France and its population?', history: '', answer: 'Paris, about 2,100,000 people.', evidence: [] }), [], 'general answers are untouched');
  assert.equal(validateDeterministic({ ...base, evidence: [ev('find_player', 'unavailable', '{"status":"unavailable"}')], answer: 'ضرره 123456 نقطة.' })[0]?.code, 'ungrounded_numbers');
});

test('validator catches API errors reported as missing entities, tool-syntax leaks and language mismatch', () => {
  const failed = [ev('find_player', 'unavailable', '{"status":"unavailable"}')];
  assert.equal(validateDeterministic({ question: 'ابحث عن Egyptian', history: '', evidence: failed, answer: 'اللاعب ده مش موجود في اللعبة.' })[0]?.code, 'error_reported_as_missing');
  assert.equal(validateDeterministic({ question: 'ابحث عن Egyptian', history: '', evidence: failed, answer: 'مقدرتش أوصل للبيانات دلوقتي، جرب كمان شوية.' }).length, 0);
  assert.equal(validateDeterministic({ question: 'x', history: '', evidence: [], answer: '{"status":"ok","data":1} text' })[0]?.code, 'tool_syntax_leak');
  assert.equal(validateDeterministic({ question: 'ازاي اكسب دهب؟', history: '', evidence: [], answer: 'You should work every day and keep your gold safe in the bank for later use.' })[0]?.code, 'language_mismatch');
  assert.equal(validateDeterministic({ question: 'hi', history: '', evidence: [], answer: '' })[0]?.code, 'empty');
});

test('LLM verifier parses verdicts and fails open on garbage', async () => {
  const input = { question: 'q', history: '', answer: 'a', evidence: [ev('search_knowledge', 'ok', 'text', 'knowledge')] };
  assert.equal((await verifyWithLlm(new ScriptedLlm([{ content: '{"answers_question":true,"supported":true,"issues":[]}' }]), input)).length, 0);
  const issues = await verifyWithLlm(new ScriptedLlm([{ content: '```json\n{"answers_question":true,"supported":false,"issues":["cost is not in sources"]}\n```' }]), input);
  assert.equal(issues[0]?.code, 'unsupported_claims');
  assert.equal((await verifyWithLlm(new ScriptedLlm([{ content: 'not json' }]), input)).length, 0);
});

// ---------------------------------------------------------------- agent loop (scripted model: tests the machinery, not model quality)
async function wikiKb() { return KnowledgeBase.create({ dir: path.resolve('knowledge') }); }

test('loop: greeting needs no tools and makes exactly one model call', async () => {
  const llm = new ScriptedLlm([{ content: 'أهلاً! أنا مساعد AoN، تحب نبدأ بإيه؟' }]);
  const out = await runAgent({ llm, tools: createTools({ api: new FakeApi({}) }), toolContext: ctx(new FakeApi({})) }, { system: 's', history: [], userMessage: 'هاي' });
  assert.equal(out.llmCalls, 1);
  assert.equal(out.trace.length, 0);
});

test('loop: knowledge question -> search -> grounded answer; tool results reach the model and numbers pass validation', async () => {
  const kb = await wikiKb();
  const api = new FakeApi({});
  const llm = new ScriptedLlm([
    { toolCalls: [call('search_knowledge', { queries: ['تكلفة تأسيس الشركة الثالثة الفولاذ الخرسانة', 'company 3 founding cost'] }, 't1')] },
    { content: 'الشركة التالتة بتكلف **60 فولاذ** و **60 خرسانة** حسب الويكي.' },
  ]);
  const out = await runAgent({ llm, tools: createTools({ api, knowledge: kb }), toolContext: ctx(api, kb) }, { system: 's', history: [], userMessage: 'طيب لو عايز اعمل شركة تالتة محتاج كام حديد؟' });
  assert.equal(out.answer.includes('60 فولاذ'), true);
  assert.equal(out.unresolvedIssues.length, 0);
  const toolMessage = llm.requests[1]!.messages.find((m) => m.role === 'tool')!;
  assert.match(toolMessage.content!, /الشركة 3 \| 60 \| 60/u);
  assert.equal(llm.requests[1]!.messages.find((m) => m.role === 'assistant')?.toolCalls?.[0]?.id, 't1');
});

test('loop: hallucinated number is caught, the model is told why, and the revised answer is returned', async () => {
  const kb = await wikiKb();
  const llm = new ScriptedLlm([
    { toolCalls: [call('search_knowledge', { queries: ['تأسيس الشركة الثالثة الفولاذ'] })] },
    { content: 'محتاج 75 فولاذ و 75 خرسانة.' },
    { content: 'حسب الويكي محتاج 60 فولاذ و60 خرسانة.' },
  ]);
  const out = await runAgent({ llm, tools: createTools({ knowledge: kb }), toolContext: ctx(undefined, kb) }, { system: 's', history: [], userMessage: 'كام حديد للشركة التالتة' });
  assert.equal(out.revisions, 1);
  assert.match(out.answer, /60/u);
  const revisionPrompt = llm.requests[2]!.messages.at(-1)!.content!;
  assert.match(revisionPrompt, /75/u);
  assert.match(revisionPrompt, /not from the player/u);
});

test('loop: an answer that stays ungrounded after the revision budget is returned flagged (service adds a caveat)', async () => {
  const kb = await wikiKb();
  const llm = new ScriptedLlm([{ toolCalls: [call('search_knowledge', { queries: ['شركة'] })] }, { content: 'تكلف 7777777 ذهب.' }]);
  const out = await runAgent({ llm, tools: createTools({ knowledge: kb }), toolContext: ctx(undefined, kb), maxRevisions: 0 }, { system: 's', history: [], userMessage: 'كام تكلفة الشركة' });
  assert.equal(out.unresolvedIssues[0]?.code, 'ungrounded_numbers');
});

test('loop: parallel tool calls run, identical repeated calls are served from the per-answer cache, errors do not stop the answer', async () => {
  const api = new FakeApi({ '/players/by-name/Egyptian': PLAYER, '/search?q=Egypt': { countries: [{ id: 'eg', name: 'Egypt' }] }, '/countries/eg': EG });
  const llm = new ScriptedLlm([
    { toolCalls: [call('find_player', { username: 'Egyptian' }), call('get_country', { country: 'Egypt' }), call('find_player', { username: 'Egyptian' }), call('does_not_exist', {})] },
    { content: 'اللاعب مستواه 47 وسكان مصر 639.' },
  ]);
  const out = await runAgent({ llm, tools: createTools({ api }), toolContext: ctx(api) }, { system: 's', history: [], userMessage: 'قارن' });
  assert.equal(api.paths.filter((p) => p === '/players/by-name/Egyptian').length, 1);
  assert.deepEqual(out.trace.map((t) => t.status), ['ok', 'ok', 'ok', 'invalid_input']);
  assert.equal(out.unresolvedIssues.length, 0);
  const replies = llm.requests[1]!.messages.filter((m) => m.role === 'tool');
  assert.equal(replies.length, 4, 'every tool call is answered');
});

test('loop: invalid JSON arguments and a crashing tool are returned to the model as structured errors', async () => {
  const llm = new ScriptedLlm([{ toolCalls: [{ id: 'x', name: 'calculate', arguments: '{oops' }, call('calculate', { expression: '1/0' })] }, { content: 'تعذر الحساب.' }]);
  const out = await runAgent({ llm, tools: createTools({}), toolContext: ctx(undefined) }, { system: 's', history: [], userMessage: 'احسب' });
  assert.deepEqual(out.trace.map((t) => t.status), ['invalid_input', 'invalid_input']);
});

test('loop: tool budget forces a final tool-less answer instead of an error; empty completions are retried once', async () => {
  const llm = new ScriptedLlm([(r, i) => (r.toolChoice !== 'none' && i < 10 ? { toolCalls: [call('calculate', { expression: `${i}+1` })] } : { content: 'خلصت.' })]);
  const out = await runAgent({ llm, tools: createTools({}), toolContext: ctx(undefined), maxSteps: 3 }, { system: 's', history: [], userMessage: 'x' });
  assert.equal(out.answer, 'خلصت.');
  assert.equal(llm.requests.at(-1)!.toolChoice, 'none');
  const empties = new ScriptedLlm([{ content: '' }, { content: 'تمام' }]);
  assert.equal((await runAgent({ llm: empties, tools: [], toolContext: ctx(undefined) }, { system: 's', history: [], userMessage: 'x' })).answer, 'تمام');
});

// ---------------------------------------------------------------- prompt
test('system prompt carries the wiki outline, active player and summary but no game facts or keyword rules', () => {
  const prompt = buildSystemPrompt({ now: new Date('2026-11-14T00:00:00Z'), hasKnowledge: true, hasGameApi: true, knowledgeOutline: '- 02-economy.md: 1. الشركات', summary: 'Player is new and likes economy.', activePlayer: { id: 'usr_a', username: 'Egyptian', fetchedAt: 't' } });
  assert.match(prompt, /02-economy\.md/u);
  assert.match(prompt, /Egyptian \(id usr_a/u);
  assert.match(prompt, /Player is new/u);
  assert.match(prompt, /temporary|TEMPORARY/u);
  assert.doesNotMatch(buildSystemPrompt({ now: new Date(), hasKnowledge: false, hasGameApi: false }), /search_knowledge|get_country/u);
});
