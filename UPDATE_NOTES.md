# Update notes: free-only multi-provider routing

Added: src/llm/free-models.ts, test/free-only.test.ts
Modified: src/llm/{presets,openai-compatible,failover,limiter,http}.ts, src/logging/logger.ts, src/config/env.ts, eval/check-providers.ts, package.json, .env.example, SETUP.md, README.md, test/llm.test.ts, test/foundation.test.ts
Deleted (stale old-project files, one of them a Groq client that bypassed the allowlist): src/groq/, src/conversation/, src/assistant/intent.ts, src/assistant/tools.ts, src/knowledge/api-reference.ts, src/knowledge/retrieval.ts

Apply: copy over your project (never overwrite `.env`), delete the stale files, then follow SETUP.md section 4.
