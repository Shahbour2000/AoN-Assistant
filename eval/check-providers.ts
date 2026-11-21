/**
 * npm run check:providers — verifies YOUR configuration against the real provider APIs (needs your keys + internet).
 *
 * It tests the exact chain the bot will use (LLM_PRIMARY/LLM_BACKUP, or the default free chain when LLM_PRIMARY is unset) and reports
 * EVERY provider/model separately. For each one, three independent probes: chat, tool calling, Arabic. A probe that was not run
 * is reported as "not tested" — never as working. Providers with no API key are listed as "not configured (not available)".
 * Nothing is sent to a model that is not on the free-only allowlist. Each probe sends only short fixed strings.
 * OpenRouter free models allow only 50 requests/day, so the check spends 3 of them per OpenRouter model: run it sparingly.
 *
 * Exit code: 0 only if every model in the chain passed all three probes and embeddings (if configured) passed; otherwise 1.
 */
import 'dotenv/config';
import { assertFreeChatModel } from '../src/llm/free-models.js';
import { PROVIDER_PRESETS, buildEmbedder, buildLlm, buildProvider, type ProviderSpec } from '../src/llm/presets.js';

const env = process.env;
type Status = 'OK' | 'FAILED' | 'not tested';
interface Row { label: string; chat: Status; tools: Status; arabic: Status; note: string[] }

const short = (text: string, n = 60) => text.replace(/\s+/g, ' ').trim().slice(0, n);
const describe = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/(sk|gsk|key|token)[-_A-Za-z0-9]{12,}/giu, '[redacted]').slice(0, 220);
};

async function probe(spec: ProviderSpec): Promise<Row> {
  const label = `${spec.provider}:${spec.model}`;
  const row: Row = { label, chat: 'not tested', tools: 'not tested', arabic: 'not tested', note: [] };
  try { assertFreeChatModel(spec.provider, spec.model); } catch (error) { row.note.push(`REJECTED by the free-only allowlist, nothing was sent: ${describe(error)}`); return row; }
  let provider;
  try { provider = buildProvider(spec, env); } catch (error) { row.note.push(`cannot be built: ${describe(error)}`); return row; }

  try {
    const reply = await provider.chat({ messages: [{ role: 'user', content: 'Reply with exactly: pong' }], maxTokens: 120, temperature: 0 });
    row.chat = reply.content.trim() ? 'OK' : 'FAILED';
    row.note.push(`chat → "${short(reply.content, 40)}"`);
  } catch (error) { row.chat = 'FAILED'; row.note.push(`chat error: ${describe(error)}`); }

  try {
    const reply = await provider.chat({
      messages: [{ role: 'user', content: 'Use the add tool to compute 17 + 25.' }],
      tools: [{ name: 'add', description: 'Add two integers', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }],
      maxTokens: 300, temperature: 0,
    });
    const call = reply.toolCalls[0];
    const good = call?.name === 'add' && (() => { try { const a = JSON.parse(call.arguments) as { a?: number; b?: number }; return a.a === 17 && a.b === 25; } catch { return false; } })();
    row.tools = good ? 'OK' : 'FAILED';
    if (!good) row.note.push('tool calling did not produce a valid add(17,25) call: do not rely on this model for tool use');
  } catch (error) { row.tools = 'FAILED'; row.note.push(`tool-calling error: ${describe(error)}`); }

  try {
    const reply = await provider.chat({ messages: [{ role: 'user', content: 'ما هي عاصمة مصر؟ أجب بكلمة واحدة بالعربية.' }], maxTokens: 200, temperature: 0 });
    const arabic = /[؀-ۿ]/u.test(reply.content);
    row.arabic = arabic ? 'OK' : 'FAILED';
    row.note.push(`arabic → "${short(reply.content, 30)}"`);
  } catch (error) { row.arabic = 'FAILED'; row.note.push(`arabic error: ${describe(error)}`); }
  return row;
}

async function main() {
  const notConfigured: string[] = [];
  for (const [name, preset] of Object.entries(PROVIDER_PRESETS)) {
    const missing = [preset.keyEnv, ...(name === 'cloudflare' ? ['CLOUDFLARE_ACCOUNT_ID'] : [])].filter((key) => !env[key]?.trim());
    if (missing.length) notConfigured.push(`${name} (missing ${missing.join(', ')})`);
  }

  let chain: ProviderSpec[] = [];
  try { chain = buildLlm(env, undefined, (m) => console.log(`! ${m}`)).specs; }
  catch (error) { console.log(`✗ ${describe(error)}`); process.exitCode = 1; }
  if (!env.LLM_PRIMARY?.trim()) console.log('! LLM_PRIMARY is not set: using the default free chain built from every provider that has a key.');

  console.log(`\nChain the bot will use, in order: ${chain.map((s) => `${s.provider}:${s.model}`).join(' → ') || '(empty)'}`);
  for (const name of notConfigured) console.log(`- ${name}: NOT CONFIGURED → not available, not tested`);
  console.log('');

  const rows: Row[] = [];
  for (const spec of chain) {
    const row = await probe(spec);
    rows.push(row);
    console.log(`${row.label}\n   chat: ${row.chat} | tool calling: ${row.tools} | Arabic: ${row.arabic}`);
    for (const note of row.note) console.log(`   · ${note}`);
  }

  let embedStatus: string;
  let embedOk = true;
  let embedder;
  try { embedder = buildEmbedder(env); } catch (error) { embedder = undefined; embedStatus = `config error: ${describe(error)}`; embedOk = false; }
  embedStatus ??= 'NONE (search will be keyword-only; the glossary still bridges common English terms)';
  if (embedder) {
    try {
      const [en, ar, other] = await embedder.embed(['How much steel does the third company cost?', 'كم تكلفة الشركة الثالثة من الفولاذ؟', 'The weather is sunny today'], 'query');
      const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
      const same = cos(en!, ar!), diff = cos(en!, other!);
      embedOk = same > diff + 0.05;
      embedStatus = `${embedder.id}: ${embedOk ? 'OK' : 'FAILED'} (dims=${en!.length}; EN↔AR ${same.toFixed(3)} vs unrelated ${diff.toFixed(3)})`;
    } catch (error) { embedOk = false; embedStatus = `${embedder.id}: FAILED (${describe(error)})`; }
  }

  console.log('\n=== Summary (only what was actually tested) ===');
  console.log('model'.padEnd(52), 'chat'.padEnd(11), 'tools'.padEnd(11), 'arabic');
  for (const row of rows) console.log(row.label.padEnd(52), row.chat.padEnd(11), row.tools.padEnd(11), row.arabic);
  for (const name of notConfigured) console.log(name.padEnd(52), 'not configured');
  console.log(`embeddings: ${embedStatus}`);
  const usable = rows.filter((r) => r.chat === 'OK' && r.tools === 'OK' && r.arabic === 'OK').length;
  console.log(`\n${usable} of ${rows.length} chain entries passed all three probes.${rows.length < 2 ? ' ! Only one model is in the chain: the bot has no failover. Add more free providers (see SETUP.md).' : ''}`);
  if (rows.some((r) => r.chat !== 'OK' || r.tools !== 'OK' || r.arabic !== 'OK') || !embedOk || !rows.length) process.exitCode = 1;
}
main().catch((error: unknown) => { console.error(describe(error)); process.exitCode = 1; });
