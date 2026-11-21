# Update notes: responsive assistant under free quotas

## 1. The actual cause of the waiting messages
All three waiting messages in your log came from **our own local limiter for Groq** (`LocalLimiter.acquire`, stack in your `npm run dev` output), not from the Discord request gate, not from a Groq HTTP 429, not from a daily quota and not from a timeout. Nothing was sent to Groq when they appeared (`httpStatus: undefined`).

Why it happened, in order of weight:
1. **One provider in the chain.** `LLM_PRIMARY` was unset, so the bot auto-picked Groq alone (the startup log shows `llm: ['groq:qwen/qwen3.8-27b']`). Cloudflare was only used for embeddings. There was nothing to fail over to.
2. **~5K prompt tokens per call against an 8K tokens/minute limit** (log: 4,867 / 4,970 prompt tokens). Two questions inside one minute exceed 8K, and the limiter's maximum wait was 25 s, so the second question was refused with "try again in 27/41/59 s". The 59 s wait is exactly "one full TPM window".
3. **A failed revision call threw away a good draft.** The 10:36 answer failed validation (`ungrounded_numbers`), the revision call needed more tokens, the limiter refused it, and the user got an error instead of the answer that was already written.
4. Retries by the user spent more of the same window.

The app gate (12 questions/min per user, 120/min globally) never triggered and was left unchanged: it is real abuse protection, and now it has its own message ("you are sending messages too fast") that is no longer confused with AI quota.

## 2. What changed
**Diagnostics** (no secrets are ever logged): every refusal now says which mechanism blocked it (`source`: `local_limiter`, `local_budget`, `provider_429`, `daily_quota`, `all_providers`), the limit (`rpm/tpm/rpd/tpd`), requested/used/max tokens, whether the request reached the provider, provider+model, and the cool-down seconds. Success logs show provider, model, prompt/completion tokens and tool calls. `Agent request prepared` logs the tool set, passages found and approximate prompt size.

**Provider chain:** with `LLM_PRIMARY` blank the bot builds the chain from the keys present: Groq main → Cloudflare gpt-oss-120b → Groq gpt-oss-120b (separate quota bucket) → OpenRouter `:free`. `LLM_BACKUP=auto` appends the same defaults to an explicit chain. Providers without keys are not in the chain. A limited provider is skipped until its cool-down ends; the next one answers immediately. If all are limited for under 45 s (`LLM_MAX_WAIT_SECONDS`) the bot waits once; otherwise it reports the real soonest recovery time. Provider-side `bad_request` also fails over.

**Token economy** (measured with the real wiki, keyword mode, using the project's token estimator):
- greeting: ~4.9K → ~0.34K tokens (no wiki search, no tools);
- wiki question ("how many skill points per level"): ~4.1–4.7K → ~1.8–2.4K tokens, one model call (best 3 passages prefetched locally, lean tool set, condensed system prompt, shorter history);
- the wiki outline (~1K) is added only when the automatic search was weak;
- questions that need live game data keep the full tool set (~4.2K);
- identical question + identical context (history, system prompt, evidence, tools) is served from a cache, so no model call. Different user/history/active player/question = different key. Answers that used live data or failed validation are never cached;
- if the revision call fails, the first draft is returned with its honesty caveat instead of an error.

**Messages:** separate Arabic messages for the app gate, all-providers-busy (seconds), longer waits (minutes) and daily-quota exhaustion (hours), timeout/unavailable, bad key, invalid response, request too large.

**Retrieval:** the glossary (`knowledge/00-glossary.md`, rows added for skill points / level) now works in both directions, English term → Arabic wiki terms and Arabic → English, and the English stop-word list was extended. English-only questions find the Arabic wiki offline in keyword mode for the cases I tested (see section 5).

**Config:** `loadConfig(env = process.env)` now accepts an environment argument (this fixes the five TS2554 errors in `test/config.test.ts`), and blank values (`LLM_PRIMARY=`) mean "not set". Before this, a blank `LLM_PRIMARY=` copied from `.env.example` would have stopped startup. `ASSISTANT_CHANNEL_ID`, which the code never read, was removed.

**Tools:** `npm run check:providers` rewritten (per provider and per model: chat / tool calling / Arabic as OK, FAILED or *not tested*, unconfigured providers listed, summary table). `npm run eval:retrieval` created (`eval/retrieval.ts`).

**Not done, on purpose: a generic "deterministic wiki answerer".** Computing "level 29 → skill points" locally would need a general way to turn free-text wiki rules and Arabic/English questions into formulas. Without that it would be either hardcoded per rule (you asked for no hardcoding) or an extractive guesser that can state wrong numbers confidently. I chose the safer route: the retrieved rule goes to the model with one cheap call (~2K tokens), and the model has the `calculate` tool and the number-grounding validator. If you want it later, the first step is a structured rules table in the wiki (rule name, unit, formula) that code can read.

## 3. New / changed environment variables
All optional. New: `LLM_MAX_WAIT_SECONDS` (default 45), `GROQ_REASONING_EFFORT`, `CLOUDFLARE_REASONING_EFFORT` (default `low`; `off` omits it), `EVAL_PACE_SECONDS` (eval only). `LLM_PRIMARY` / `LLM_BACKUP` are now normally **blank**; `LLM_BACKUP` accepts `auto`. `EMBEDDING_PROVIDER=auto` is the default. Removed: `ASSISTANT_CHANNEL_ID`.

## 4. Manual configuration you must do
1. In your `.env`, make sure `LLM_PRIMARY=` and `LLM_BACKUP=` are **blank or deleted**. Keep your `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` (you already have them for embeddings): they now also provide the second chat provider. Add `OPENROUTER_API_KEY` only if you want the last-resort provider. Do not overwrite your `.env` with `.env.example`.
2. `npm install`, then `npm run typecheck`, `npm test`, `npm run check:providers`, `npm run eval:retrieval`.
3. Start the bot and confirm the startup log lists **more than one** provider in `llm:`.

## 5. What was actually run
Run in my sandbox (no network access to providers, no `npm install` possible, no API keys):
- `npm test` test files that can run without installing packages: llm 13, free-only 13, knowledge 16 (+1 TODO), agent 21, service 8, regression 9, token-economy 16 (new), config 4 = **100 passing, 0 failing**. `config.test.ts` ran against a stand-in `dotenv` and the sandbox's zod 3.25 (your project pins zod 4), so please re-run it.
- **Not run:** `test/foundation.test.ts` and `test/integration.test.ts` (need `better-sqlite3`, not installable here). They were not changed.
- **Typecheck:** the full `npm run typecheck` could not run (missing `better-sqlite3`, `discord.js`, `dotenv`, `zod` 4 packages). I ran `tsc` over src + test + eval with Node types and found **no errors apart from those caused by the missing packages**, and none in `test/config.test.ts`. Please run it yourself.
- **Keyword retrieval eval (offline, real wiki):** 6 of 8 cases in the top 5. English-only questions about wages currency and about damage calculation do **not** match in keyword mode (no glossary bridge); they need the embedder.
- **Not run, need your keys + internet:** `npm run check:providers`, the hybrid half of `npm run eval:retrieval`, and the live Cloudflare retrieval test in `test/knowledge.test.ts`.

## 6. Providers actually tested live
By me in this session: **none** (no keys, no network). From your own output in the previous round: Groq `qwen/qwen3.8-27b` chat, tool calling and Arabic OK; Cloudflare `bge-m3` embeddings OK (1024 dims, EN↔AR 0.847 vs 0.320 unrelated). **Cloudflare chat and OpenRouter chat have never been tested live** by anyone yet, and I make no claim that they work. Run `npm run check:providers`; it will say per model what passed.

## 7. Remaining limitations (honest)
- The Cloudflare chat request sends `reasoning_effort: low`. That parameter is unverified against Workers AI; if Cloudflare rejects it the provider retries once without it and logs it, but this is untested. Set `CLOUDFLARE_REASONING_EFFORT=off` if `check:providers` complains.
- Free tiers are finite. With Groq (8K TPM) + Cloudflare (10K neurons/day) the bot should absorb normal bursts, since a wiki question is now ~2K tokens, but I could not measure live capacity; my numbers are estimates. A busy server can still exhaust everything, and then players get an accurate "wait N minutes/hours" message.
- Conversation summarisation runs in the background and also uses model calls once a conversation grows long.
- The token figures were measured with the project's estimator in keyword mode; real tokenizer counts and hybrid mode will differ somewhat.
- The English-only retrieval test against embeddings is reported as TODO unless Cloudflare credentials are present in the environment; it is not skipped silently and runs for real when they are.
- Free-only policy is unchanged: allowlist, `:free` OpenRouter IDs only, no paid fallback, no card. Groq's and OpenRouter's signup card requirements are still not confirmed on official pages I could read.
