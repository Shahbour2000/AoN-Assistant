# Update notes: audit fixes (2026-11-21)

Fixed
- **Blank `LLM_PRIMARY` + `LLM_BACKUP` built a one-provider chain (Groq only)**, so Cloudflare chat and OpenRouter were never used and the Groq 8,000 tokens/minute limit still stopped consecutive questions. It now builds Groq main -> Cloudflare -> Groq secondary -> OpenRouter free from the keys that exist (`autoChainSpecs`/`resolveChainSpecs` in src/llm/presets.ts). Explicit settings behave as before.
- **Failover waited instead of switching**: a provider's local limiter could pause a request for up to 25 s before failing. In a multi-provider chain every provider except the last now gives up after 1.5 s so the next one answers immediately.
- **Stale files the previous notes said were deleted were still in the ZIP**, including `src/groq/client.ts` (a Groq client that bypassed the free-model allowlist). Removed it and the unused files that depended on it (`src/conversation/`, `src/assistant/intent.ts`, `src/assistant/tools.ts`, `src/knowledge/api-reference.ts`, `src/knowledge/retrieval.ts`). Nothing live imported them.
- `eval/check-providers.ts` uses the same chain resolution as the bot and prints the chain.
- `knowledge/00-glossary.md`: added word-only rows (skill points, level, level up, declare war) so Arabic slang finds the English "Level rewards" passage in keyword mode. No game rules or numbers added.
- `.env.example` lists the Cloudflare/OpenRouter/LLM_* variables.

Tests: test/llm.test.ts updated (old test asserted the one-provider behaviour) and a new failover scenario added (Groq answers, then hits its local token limit, the next question goes to Cloudflare without waiting, later questions skip Groq).

Not verified here (no credentials / no network for installs): live Groq, Cloudflare chat and embeddings, OpenRouter calls; Discord login; `npm install`, `npm run typecheck`, `foundation`/`integration` tests (need better-sqlite3).

---
# Update notes: free-only multi-provider routing

Added: src/llm/free-models.ts, test/free-only.test.ts
Modified: src/llm/{presets,openai-compatible,failover,limiter,http}.ts, src/logging/logger.ts, src/config/env.ts, eval/check-providers.ts, package.json, .env.example, SETUP.md, README.md, test/llm.test.ts, test/foundation.test.ts
Deleted (stale old-project files, one of them a Groq client that bypassed the allowlist): src/groq/, src/conversation/, src/assistant/intent.ts, src/assistant/tools.ts, src/knowledge/api-reference.ts, src/knowledge/retrieval.ts

Apply: copy over your project (never overwrite `.env`), delete the stale files, then follow SETUP.md section 4.
