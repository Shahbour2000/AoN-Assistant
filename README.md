# AoN Assistant

A Discord assistant for the browser strategy game **Age of Nations**. It is a general conversational AI (Egyptian Arabic, Modern Standard Arabic, English) that also knows the game: mechanics come only from the Markdown wiki in `knowledge/`, live facts come only from the real game API.

## How it works

```
Discord message
  → AssistantService  (per-user/channel memory, active-player context, request gate)
  → Agent loop        (the model decides: answer directly, search the wiki, call game-API tools, calculate)
       ├─ search_knowledge → hybrid RAG: heading-aware chunks, BM25 (Arabic-normalised + stemmed) + embeddings, rank fusion
       ├─ game tools       → find_player, get_player_data, search_game, get_country, get_market, get_rankings, get_wars (read-only AoN API)
       └─ calculate        → exact arithmetic on game numbers
  → Validator         (numbers must appear in tool evidence; API failure ≠ "not found"; no tool-syntax leaks; language match) + one revision pass
  → Reply in the player's language
```

- **No keyword routing.** Whether to search the wiki, call the API or just chat is decided by the model from the conversation; tool results always go back to the model.
- **Knowledge:** drop `.md` files anywhere under `knowledge/` (see `knowledge/README.md`); they are indexed automatically. Embeddings are cached in `data/embeddings.json` by content hash, so only new/changed passages are embedded. If embeddings are unavailable the search degrades to keyword-only and says so in the logs.
- **Game API:** `https://app.ageofnations.world/api/v1`, read-only, no key. Cached 30 s, deduplicated, paced below 60 requests/min. Statuses: `not_found` only for a real 404; timeouts/429/malformed → "temporarily unavailable", never "doesn't exist".
- **Memory:** recent whole messages within a token budget plus a rolling summary of older turns, isolated per guild+user+channel. No cross-user leakage.
- **Cost safety:** only free-tier providers are configured; the local limiter mirrors each free-tier limit; failover goes only to approved free providers: the ones you list in `LLM_BACKUP`, or, when `LLM_PRIMARY` and `LLM_BACKUP` are both blank, every provider whose key is present (Groq main -> Cloudflare -> Groq secondary -> OpenRouter free); there is no automatic switch to a paid plan or model.

## Setup

1. Node.js 22+ and npm. `npm install`.
2. `cp .env.example .env`, fill in Discord values and at least one LLM key (Groq already works; see SETUP.md).
3. Put game Markdown in `knowledge/` (the five bundled wiki files plus `00-glossary.md` are included).
4. `npm run typecheck`, then `npm run dev` (or `npm run build && npm start`).
5. In Discord use `/ping`, `/ask`, or talk in the configured assistant channel.

## Free providers (checked against official docs on 2026-11-20; see SETUP.md)

Free-only by design: `src/llm/free-models.ts` is an allowlist; any model not on it is rejected at startup. Mistral and Gemini were removed from this version because their free status was not re-verified.

| Provider | Card needed? | Free limits | Models allowed | Role |
| --- | --- | --- | --- | --- |
| **Groq** (Free plan) | Not stated in the docs I could read; your existing key works. Card is only needed to upgrade (not verified on an official page) | per model: 30 RPM, 1K RPD, **8K TPM**, 200K TPD | `qwen/qwen3.8-27b` (preview), `openai/gpt-oss-120b`, `openai/gpt-oss-20b`, `llama-3.3-70b-versatile`, `llama-3.1-8b-instant` | Primary + second bucket |
| **Cloudflare Workers AI** (Free plan) | No payment method on the Free plan; some models need Workers Paid and are blocked | 10,000 neurons/day, then calls fail (not billed) | chat `@cf/openai/gpt-oss-120b`, `@cf/qwen/qwen3.8-27b`, `@cf/meta/llama-3.3-70b-instruct-fp8-fast`; embeddings `@cf/baai/bge-m3` | Backup + embeddings |
| **OpenRouter** `:free` | Free models need no purchase per the limits page; account-signup card requirement not stated, so optional | 20 RPM, **50 requests/day** (1,000 only after buying credits - do not) | `google/gemma-4-26b-a4b-it:free`, `nvidia/nemotron-3.5-super-vl:free` | Last resort |
| Mistral, Gemini | not re-verified | - | none (disabled) | Removed |

**Safeguards:** allowlist; OpenRouter IDs must end in `:free`; requests carry one model only (no `models` fallback list); 429/quota errors cause cool-downs until reset; Cloudflare daily neuron budget tracked locally (max 10,000); logs name provider+model per request and redact keys. Billing still depends on your *account* plan (never upgrade).

## Environment variables

See `.env.example` (complete, with placeholders) and `SETUP.md`: `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `ASSISTANT_CHANNEL_ID`, `LLM_PRIMARY`, `LLM_BACKUP`, `GROQ_API_KEY` (legacy `GROQ_MODEL` still works), `OPENROUTER_API_KEY`, `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_DAILY_NEURON_BUDGET`, `CLOUDFLARE_REASONING_EFFORT`, `VALIDATION_MODE`, `LLM_LIMITS_<PROVIDER>`, `LLM_TIMEOUT_MS`, `DATABASE_PATH`, `KNOWLEDGE_DIR`, `LOG_LEVEL`.

## Commands

- `npm run dev` / `npm run build` / `npm start` — run, compile, run compiled.
- `npm run typecheck` — source plus tests and eval.
- `npm test` — offline test suites (including `test/regression.test.ts`, the real Discord conversations that failed) (all external services mocked: scripted model, fake HTTP, in-memory DB). **These do not prove live model quality.**
- `npm run check:providers` — verifies your keys, that the configured chat/embedding model IDs exist, one tiny chat call, and English↔Arabic embedding similarity. Run this first.
- `npm run eval [filter]` — **live** evaluation against the real model provider and the real AoN API (`eval/scenarios.ts`: general chat, beginner help, Egyptian Arabic, hallucination traps, API tools, simulated API faults). Consumes free-tier quota; needs keys and internet. Scenarios with a REVIEW note need a human to read the answer.

## Player accounts and personalized answers

- `/link username:<in-game name>` looks up the public player profile and asks you to confirm it. Confirmation records your Discord ID and the stable AoN player ID. It does **not** verify that you own that game account.
- `/unlink` removes your association. To change accounts, unlink first and then run `/link` again.
- `/profile`, `/stats`, and `/analyze` show public API data and a preliminary activity classification. `/refresh` clears the local snapshot cache and fetches fresh data.
- Linking is optional. A linked account is only a default for "my account" questions; any player can be looked up by simply naming them in the conversation. The active player is remembered temporarily (2 hours) and only inside that private conversation.
- `/analyze` reports current momentum by comparing each category’s weekly amount with its own 30-day total, normalized to a weekly pace. The dimensionless indices are compared with a 25% relative margin; missing, zero, malformed, or inconsistent windows produce “insufficient data.” This is a recent-momentum heuristic, not a judgment of player quality.
- Historical specialization remains “insufficient data”: the API reports lifetime damage in damage points and work/trade as counts, with no validated common scale or comparison cohort. The bot does not compare those raw units or infer a lifetime specialty from them.
- The public API has no account-ownership verification flow. Do not treat link confirmation as ownership proof. Public profile and company fields can be absent; timestamps indicate when the snapshot was fetched.

Automated tests mock all external API calls. No AoN API key is required, and the app does not poll the API.

## Source layout

`src/llm` provider layer (OpenAI-compatible provider, limiter, failover, presets) · `src/knowledge` chunker, BM25, vector store, hybrid search · `src/agent` loop, tools, validator, memory, prompt · `src/assistant/service.ts` orchestration · `src/aon-api` API client, linking, analysis · `src/discord` Discord glue · `src/database` SQLite migrations/repositories · `test/` offline suites · `eval/` live evaluation.
