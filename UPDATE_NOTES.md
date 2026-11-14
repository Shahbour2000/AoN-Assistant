# Update notes (copy the files in this folder over your project; keep paths)

## Added
SETUP.md, src/discord/failure.ts, test/regression.test.ts

## Modified
.env.example, README.md, package.json, eval/check-providers.ts, knowledge/00-glossary.md, knowledge/README.md,
src/agent/loop.ts, src/agent/prompt.ts, src/agent/tools/knowledge.ts, src/assistant/service.ts, src/config/env.ts,
src/discord/client.ts, src/knowledge/index.ts, src/llm/limiter.ts, src/llm/openai-compatible.ts, src/llm/presets.ts

## Deleted (stale files from the OLD project that are still in your folder; delete them yourself)
src/assistant/intent.ts, src/assistant/tools.ts, src/conversation/ (whole folder), src/groq/ (whole folder),
src/knowledge/api-reference.ts, src/knowledge/retrieval.ts

## Apply
1. Copy everything from this folder into your project root, overwriting. Do NOT overwrite your real `.env` (only `.env.example` is included).
2. Delete the stale files listed above. (Windows: delete in Explorer; Mac/Linux: `rm -r src/conversation src/groq src/assistant/intent.ts src/assistant/tools.ts src/knowledge/api-reference.ts src/knowledge/retrieval.ts`)
3. No new npm packages: `npm install` is not required (run it anyway if unsure).
4. Follow SETUP.md to create keys and edit `.env`, then: `npm run typecheck && npm test && npm run check:providers`.
