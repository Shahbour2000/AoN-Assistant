/**
 * npm run check:providers — verifies YOUR configuration against the real provider APIs (needs your keys + internet).
 * For every provider/model in LLM_PRIMARY + LLM_BACKUP (or the auto-picked one) it:
 *   1. checks the model against the free-only allowlist (nothing is sent if it is not approved),
 *   2. makes one tiny chat call, one tool-calling call and one Arabic call, reporting which really work,
 *   3. tests the embedder with an English↔Arabic similarity check.
 * Each probe sends only short fixed strings. OpenRouter free models allow just 50 requests/day, so this check
 * spends 3 of them per OpenRouter model — run it sparingly.
 */
import 'dotenv/config';
import { assertFreeChatModel } from '../src/llm/free-models.js';
import { PROVIDER_PRESETS, buildEmbedder, buildProvider, parseProviderSpec, type ProviderSpec } from '../src/llm/presets.js';

const env = process.env;
const AUTO = ['groq', 'cloudflare', 'openrouter'];

function specs(): ProviderSpec[] {
  const raw = env.LLM_PRIMARY?.trim();
  if (!raw) {
    const auto = AUTO.find((name) => env[PROVIDER_PRESETS[name]!.keyEnv]?.trim());
    if (!auto) return [];
    return [parseProviderSpec(auto === 'groq' && env.GROQ_MODEL?.trim() ? `groq:${env.GROQ_MODEL.trim()}` : auto)];
  }
  return [raw, ...(env.LLM_BACKUP ?? '').split(',').map((x) => x.trim()).filter(Boolean)].map(parseProviderSpec);
}

async function probe(spec: ProviderSpec): Promise<boolean> {
  const label = `${spec.provider}:${spec.model}`;
  try { assertFreeChatModel(spec.provider, spec.model); } catch (error) { console.log(`✗ ${label} REJECTED (not sent anywhere): ${(error as Error).message}`); return false; }
  let provider;
  try { provider = buildProvider(spec, env); } catch (error) { console.log(`- ${label} skipped: ${(error as Error).message}`); return false; }
  let ok = true;
  try {
    const reply = await provider.chat({ messages: [{ role: 'user', content: 'Reply with exactly: pong' }], maxTokens: 60, temperature: 0 });
    console.log(`✓ ${label} chat OK → "${reply.content.trim().slice(0, 40)}"`);
  } catch (error) { console.log(`✗ ${label} chat failed: ${(error as Error).message}`); return false; }
  try {
    const reply = await provider.chat({
      messages: [{ role: 'user', content: 'Use the add tool to compute 17 + 25.' }],
      tools: [{ name: 'add', description: 'Add two integers', parameters: { type: 'object', properties: { a: { type: 'integer' }, b: { type: 'integer' } }, required: ['a', 'b'] } }],
      maxTokens: 200, temperature: 0,
    });
    const call = reply.toolCalls[0];
    const good = call?.name === 'add' && (() => { try { const a = JSON.parse(call.arguments) as { a?: number; b?: number }; return a.a === 17 && a.b === 25; } catch { return false; } })();
    console.log(`${good ? '✓' : '✗'} ${label} tool calling ${good ? 'OK' : 'did NOT produce a valid add(17,25) call — do not use as primary'}`);
    ok &&= Boolean(good);
  } catch (error) { console.log(`✗ ${label} tool-calling probe failed: ${(error as Error).message}`); ok = false; }
  try {
    const reply = await provider.chat({ messages: [{ role: 'user', content: 'اكتب كلمة واحدة بالعربية: ما هي عاصمة مصر؟' }], maxTokens: 120, temperature: 0 });
    const arabic = /[؀-ۿ]/u.test(reply.content);
    console.log(`${arabic ? '✓' : '?'} ${label} Arabic reply: "${reply.content.trim().slice(0, 40)}"`);
  } catch (error) { console.log(`✗ ${label} Arabic probe failed: ${(error as Error).message}`); }
  return ok;
}

async function main() {
  const chain = specs();
  if (!chain.length) { console.log('✗ No LLM configured: set GROQ_API_KEY / CLOUDFLARE_* / OPENROUTER_API_KEY and LLM_PRIMARY.'); process.exitCode = 1; return; }
  if (!env.LLM_PRIMARY?.trim()) console.log('! LLM_PRIMARY is not set — the bot will auto-pick from whichever keys exist. Set it explicitly.');
  for (const spec of chain) if (!(await probe(spec))) process.exitCode = 1;

  let embedder;
  try { embedder = buildEmbedder(env); } catch (error) { console.log(`✗ embeddings config error: ${(error as Error).message}`); process.exitCode = 1; return; }
  console.log(`Embeddings: ${embedder ? embedder.id : 'NONE (search will be keyword-only)'}  (EMBEDDING_PROVIDER=${env.EMBEDDING_PROVIDER?.trim() || 'auto'})`);
  if (embedder) {
    try {
      const [en, ar, other] = await embedder.embed(['How much steel does the third company cost?', 'كم تكلفة الشركة الثالثة من الفولاذ؟', 'The weather is sunny today'], 'query');
      const cos = (a: number[], b: number[]) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
      const same = cos(en!, ar!), diff = cos(en!, other!);
      console.log(`${same > diff + 0.05 ? '✓' : '✗'} embeddings OK (dims=${en!.length}); EN↔AR same-meaning ${same.toFixed(3)} vs unrelated ${diff.toFixed(3)}${same > diff + 0.05 ? '' : '  ← cross-lingual search will be weak'}`);
    } catch (error) { console.log(`✗ embedding call failed: ${(error as Error).message}`); process.exitCode = 1; }
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
