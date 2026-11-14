import type { LlmProvider } from '../llm/types.js';

export interface EvidenceEntry { tool: string; kind: 'knowledge' | 'game' | 'utility'; args: string; status: string; text: string; }
export interface Issue { code: 'ungrounded_numbers' | 'error_reported_as_missing' | 'language_mismatch' | 'tool_syntax_leak' | 'empty' | 'unsupported_claims' | 'off_topic'; message: string; }
export interface ValidationInput { question: string; history: string; answer: string; evidence: EvidenceEntry[]; }

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const MULTIPLIERS: Array<[RegExp, number]> = [[/^(?:b|bn|billion|مليار)/iu, 1e9], [/^(?:m|mn|million|مليون|ملايين)/iu, 1e6], [/^(?:k|thousand|الف|ألف|آلاف)/iu, 1e3]];

function toAscii(text: string): string { return text.replace(/[٠-٩]/gu, (d) => String(AR_DIGITS.indexOf(d))).replace(/[٫]/gu, '.').replace(/[٬،]/gu, ','); }

/** Numbers in text as {value, scaled}; "17.9 million" yields 17900000 in addition to the literal 17.9. */
export function extractNumbers(text: string): Array<{ literal: string; values: number[] }> {
  const ascii = toAscii(text);
  const out: Array<{ literal: string; values: number[] }> = [];
  for (const match of ascii.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*([A-Za-z؀-ۿ]*)/gu)) {
    const base = Number(`${match[1]!.replace(/,/gu, '')}${match[2] ? `.${match[2]}` : ''}`);
    if (!Number.isFinite(base)) continue;
    const values = [base];
    const word = match[3] ?? '';
    for (const [pattern, factor] of MULTIPLIERS) if (pattern.test(word)) values.push(base * factor);
    out.push({ literal: match[0].trim(), values });
  }
  return out;
}

function close(a: number, b: number): boolean { return Math.abs(a - b) <= Math.max(0.006 * Math.max(Math.abs(a), Math.abs(b)), 1e-9); }

export function evidenceNumbers(entries: EvidenceEntry[]): number[] {
  const numbers: number[] = [];
  for (const entry of entries) for (const found of extractNumbers(`${entry.args} ${entry.text}`)) numbers.push(...found.values);
  return numbers;
}

const NOT_FOUND_PHRASES = /(does not exist|doesn't exist|no such (player|user|country)|not (a )?(real|valid) (player|country)|couldn't find (any )?(player|user)|غير موجود|مش موجود|مفيش (لاعب|دولة)|لا يوجد (لاعب|دولة)|ملقيتش|مالقيتش|لم أجد)/iu;
const TOOL_LEAK = /(<tool_call>|<\/?think>|"status"\s*:\s*"(ok|not_found|unavailable)"|\bfunction_call\b|<\|[a-z_]+\|>|\{"name"\s*:\s*"[a-z_]+",\s*"arguments")/iu;

function arabicRatio(text: string): number {
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return 0;
  return letters.filter((c) => /[؀-ۿ]/u.test(c)).length / letters.length;
}

/** Cheap, deterministic checks that run on every answer. */
export function validateDeterministic(input: ValidationInput): Issue[] {
  const issues: Issue[] = [];
  const answer = input.answer.trim();
  if (!answer) return [{ code: 'empty', message: 'The answer is empty.' }];
  if (TOOL_LEAK.test(answer)) issues.push({ code: 'tool_syntax_leak', message: 'The answer contains raw tool/JSON/reasoning syntax. Write a clean natural-language answer.' });

  const gameCalls = input.evidence.filter((entry) => entry.kind !== 'utility');
  const failedOnly = gameCalls.length > 0 && gameCalls.every((entry) => !['ok', 'partial'].includes(entry.status));
  const transient = input.evidence.some((entry) => ['unavailable', 'rate_limited'].includes(entry.status));
  if (transient && NOT_FOUND_PHRASES.test(answer) && !input.evidence.some((entry) => entry.status === 'not_found')) {
    issues.push({ code: 'error_reported_as_missing', message: 'A tool failed temporarily (unavailable / rate limited). That is not proof that the player, country or data does not exist — say the live data is temporarily unavailable instead.' });
  }

  // Numbers: only enforced when the turn used game evidence, so ordinary general-knowledge answers are never touched.
  if (gameCalls.length > 0) {
    const known = [...evidenceNumbers(input.evidence), ...extractNumbers(`${input.question} ${input.history}`).flatMap((n) => n.values)];
    const unsupported: string[] = [];
    for (const found of extractNumbers(answer)) {
      if (found.values.every((v) => v <= 10 || (v >= 1990 && v <= 2100 && Number.isInteger(v)))) continue;
      if (found.values.some((v) => known.some((k) => close(v, k)))) continue;
      unsupported.push(found.literal);
    }
    if (unsupported.length) {
      issues.push({ code: 'ungrounded_numbers', message: `These numbers appear in the answer but not in any tool result or in the player's messages: ${[...new Set(unsupported)].slice(0, 8).join(', ')}.${failedOnly ? ' Every data lookup failed or came back empty, so no figures can be given.' : ''} Either support each one with a tool call (use the calculate tool for arithmetic), or remove it / clearly label it as your own estimate.` });
    }
  }

  const q = arabicRatio(input.question);
  const a = arabicRatio(answer);
  if (answer.length > 60 && ((q > 0.6 && a < 0.1) || (q === 0 && /\p{L}{3}/u.test(input.question) && a > 0.5))) {
    issues.push({ code: 'language_mismatch', message: 'Reply in the language the player wrote in (Egyptian/Modern Arabic for Arabic messages, English for English).' });
  }
  return issues;
}

const VERIFY_SYSTEM = `You audit a game-assistant draft answer. You get the PLAYER QUESTION, the EVIDENCE the assistant gathered (wiki passages and live API results) and the DRAFT.
Check strictly:
1. Does the draft actually answer the question asked?
2. Is every Age of Nations-specific fact, number, cost, formula or rule in the draft supported by the EVIDENCE? (General knowledge outside the game is fine.) Recommendations/opinions are fine if clearly framed as advice.
3. Does the draft contradict the evidence, or treat a tool error (unavailable/rate_limited) as "does not exist"?
Reply ONLY with JSON: {"answers_question": boolean, "supported": boolean, "issues": ["short, specific problem", ...]}. Use an empty issues list when all is fine. Do not rewrite the answer.`;

export async function verifyWithLlm(llm: LlmProvider, input: ValidationInput): Promise<Issue[]> {
  const evidence = input.evidence.filter((entry) => entry.kind !== 'utility' || entry.status === 'ok').map((entry) => `[${entry.tool} ${entry.args} -> ${entry.status}]\n${entry.text.slice(0, 2200)}`).join('\n\n').slice(0, 9000);
  const response = await llm.chat({ messages: [{ role: 'system', content: VERIFY_SYSTEM }, { role: 'user', content: `PLAYER QUESTION:\n${input.question}\n\nEVIDENCE:\n${evidence || '(none)'}\n\nDRAFT:\n${input.answer}` }], json: true, maxTokens: 400, temperature: 0 });
  try {
    const parsed = JSON.parse(response.content.replace(/^```(?:json)?|```$/gmu, '').trim()) as { answers_question?: boolean; supported?: boolean; issues?: unknown };
    const list = Array.isArray(parsed.issues) ? parsed.issues.filter((item): item is string => typeof item === 'string' && item.length > 0).slice(0, 5) : [];
    const issues: Issue[] = [];
    if (parsed.supported === false || (parsed.supported === undefined && list.length)) issues.push({ code: 'unsupported_claims', message: `Verifier: ${list.join('; ') || 'some claims are not supported by the evidence'}` });
    if (parsed.answers_question === false) issues.push({ code: 'off_topic', message: `The draft does not answer what the player asked.${list.length ? ` Verifier: ${list.join('; ')}` : ''}` });
    return issues;
  } catch { return []; }
}
