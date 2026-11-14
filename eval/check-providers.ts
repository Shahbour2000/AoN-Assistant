/**
 * npm run check:providers — verifies YOUR configuration against the real provider APIs (needs your keys + internet):
 *  1. lists each configured provider's models and confirms the configured chat/embedding model IDs exist,
 *  2. makes one tiny chat call and one tiny embedding call and reports the result,
 *  3. runs an English↔Arabic embedding similarity sanity check.
 * It sends only short fixed test strings and never reads the knowledge folder.
 */
import 'dotenv/config';
import { PROVIDER_PRESETS, buildEmbedder, buildLlm, parseProviderSpec, resolveBaseUrl } from '../src/llm/presets.js';

const env = process.env;
async function listModels(provider: string): Promise<string[] | string> {
  const preset = PROVIDER_PRESETS[provider]!;
  const key = env[preset.keyEnv]?.trim();
  if (!key) return 'no key set';
  if (provider === 'cloudflare') return 'model listing not available on this endpoint (the embedding test below checks it directly)';
  try {
    const response = await fetch(`${resolveBaseUrl(preset.baseUrl, env)}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return `HTTP ${response.status} ${(await response.text()).slice(0, 160)}`;
    const body = await response.json() as { data?: Array<{ id?: string }>; models?: Array<{ name?: string }> };
    return (body.data?.map((m) => m.id ?? '') ?? body.models?.map((m) => (m.name ?? '').replace(/^models\//u, '')) ?? []).filter(Boolean);
  } catch (error) { return `request failed: ${error instanceof Error ? error.message : String(error)}`; }
}

async function main() {
  const wanted = new Set<string>();
  const chat: Array<{ provider: string; model: string }> = [];
  try {
    const primary = (env.LLM_PRIMARY?.trim()) ? [parseProviderSpec(env.LLM_PRIMARY)] : [];
    const backups = (env.LLM_BACKUP ?? '').split(',').map((x) => x.trim()).filter(Boolean).map(parseProviderSpec);
    chat.push(...primary, ...backups);
  } catch (error) { console.log(`✗ config error: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; return; }
  if (!env.LLM_PRIMARY?.trim()) console.log('! LLM_PRIMARY is not set — the bot will auto-pick from whichever keys exist. Set it explicitly.');
  for (const spec of chat) wanted.add(spec.provider);
  const embedProvider = (env.EMBEDDING_PROVIDER?.trim().toLowerCase() || 'auto');
  const embedder = buildEmbedder(env);
  console.log(`Embeddings: ${embedder ? embedder.id : 'NONE (search will be keyword-only)'}  (EMBEDDING_PROVIDER=${embedProvider})`);
  for (const name of ['gemini', 'cloudflare', 'mistral']) if (env[PROVIDER_PRESETS[name]!.keyEnv]?.trim()) wanted.add(name);

  for (const provider of wanted) {
    const models = await listModels(provider);
    if (typeof models === 'string') { console.log(`${provider === 'cloudflare' ? '·' : '✗'} ${provider}: ${models}`); continue; }
    console.log(`✓ ${provider}: ${models.length} models visible`);
    for (const spec of chat.filter((c) => c.provider === provider)) console.log(`  ${models.includes(spec.model) ? '✓' : '✗ NOT LISTED'} chat model ${spec.model}`);
    const embeddingModel = env.EMBEDDING_MODEL?.trim() || PROVIDER_PRESETS[provider]!.embedding?.model;
    if (embeddingModel) console.log(`  ${models.includes(embeddingModel) ? '✓' : '? not in list'} embedding model ${embeddingModel}`);
  }

  if (chat.length || Object.values(PROVIDER_PRESETS).some((p) => env[p.keyEnv]?.trim())) {
    try {
      const { llm } = buildLlm(env, undefined, (m) => console.log(`! ${m}`));
      const reply = await llm.chat({ messages: [{ role: 'user', content: 'Reply with exactly: pong' }], maxTokens: 20, temperature: 0 });
      console.log(`✓ chat call OK via ${reply.provider}:${reply.model} → "${reply.content.trim().slice(0, 40)}"`);
    } catch (error) { console.log(`✗ chat call failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
  }
  if (embedder) {
    try {
      const [en, ar, other] = await embedder.embed(['How much steel does the third company cost?', 'كم تكلفة الشركة الثالثة من الفولاذ؟', 'The weather is sunny today'], 'query');
      const cos = (a: number[] | Float32Array, b: number[] | Float32Array) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i]! * b[i]!; x += a[i]! ** 2; y += b[i]! ** 2; } return d / Math.sqrt(x * y); };
      const same = cos(en!, ar!), diff = cos(en!, other!);
      console.log(`${same > diff + 0.05 ? '✓' : '✗'} embeddings OK (dims=${en!.length}); EN↔AR same-meaning similarity ${same.toFixed(3)} vs unrelated ${diff.toFixed(3)}${same > diff + 0.05 ? '' : '  ← cross-lingual search will be weak'}`);
    } catch (error) { console.log(`✗ embedding call failed: ${error instanceof Error ? error.message : String(error)}`); process.exitCode = 1; }
  }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
