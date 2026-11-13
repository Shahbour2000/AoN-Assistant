# AoN Assistant

Standalone Discord assistant for Age of Nations. The project targets Node.js 22+, TypeScript, Discord.js, Groq's OpenAI-compatible API, and SQLite.

## Current phase

The runnable bot provides `/ping`, `/ask`, private support tickets, and Groq responses grounded in locally retrieved Markdown. Optional AoN account linking adds public profile/statistics context to answers; account links are not proof of ownership.

## Setup

1. Install Node.js 22 or newer and npm.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and configure the Discord and Groq values below. Tests use mocked provider calls and need no real credentials.
4. Add trusted `.md` files under `knowledge/`.
5. Run `npm run typecheck`, then `npm run dev`.

The bundled knowledge set includes `01-basics.md`, `02-economy.md`, `03-war.md`, `04-politics.md`, and `05-community.md`. Startup discovers all Markdown files recursively; retrieval ranks chunks from the combined set for each question.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application/client ID used to register slash commands |
| `GROQ_API_KEY` | Required GroqCloud API key |
| `GROQ_MODEL` | Groq model (defaults to `qwen/qwen3.8-27b`) |
| `DATABASE_PATH` | SQLite database file path |
| `KNOWLEDGE_DIR` | Markdown knowledge directory |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |

Keep `.env` private. Never commit bot tokens or API keys. Knowledge Markdown files are ignored by Git; `knowledge/README.md` is tracked.

The AoN public API uses `https://app.ageofnations.world/api/v1` and needs no key or additional environment variable. Responses are cached locally for 30 seconds and calls are paced below its documented 60 requests/minute/IP limit.

## Commands

- `npm run dev` — run the startup check in watch mode.
- `npm run build` — compile to `dist/`.
- `npm start` — run the compiled startup check.
- `npm run typecheck` — validate TypeScript without emitting files.
- `npm test` — run foundation, API, account-linking, analysis, and integration tests with mocked external requests.

## Run the bot

1. Create a Discord application and bot in the Discord Developer Portal.
2. Invite it to your server with the `bot` and `applications.commands` scopes and permission to view/send messages.
3. Create a GroqCloud API key and set `GROQ_API_KEY` in `.env`; never commit that file.
4. Add game Markdown sources under `knowledge/`.
5. Run `npm run dev` for development or `npm run build && npm start` for compiled execution.
6. Use `/ping` to check availability and `/ask question:<your question>` to ask about the game.

## Player accounts and personalized answers

- `/link username:<in-game name>` looks up the public player profile and asks you to confirm it. Confirmation records your Discord ID and the stable AoN player ID. It does **not** verify that you own that game account.
- `/unlink` removes your association. To change accounts, unlink first and then run `/link` again.
- `/profile`, `/stats`, and `/analyze` show public API data and a preliminary activity classification. `/refresh` clears the local snapshot cache and fetches fresh data.
- When a linked user asks a question, the assistant includes a bounded profile/statistics summary alongside relevant Markdown chunks. Missing or unavailable API data is disclosed; game mechanics remain grounded in the Markdown knowledge base.
- `/analyze` reports current momentum by comparing each category’s weekly amount with its own 30-day total, normalized to a weekly pace. The dimensionless indices are compared with a 25% relative margin; missing, zero, malformed, or inconsistent windows produce “insufficient data.” This is a recent-momentum heuristic, not a judgment of player quality.
- Historical specialization remains “insufficient data”: the API reports lifetime damage in damage points and work/trade as counts, with no validated common scale or comparison cohort. The bot does not compare those raw units or infer a lifetime specialty from them.
- The public API has no account-ownership verification flow. Do not treat link confirmation as ownership proof. Public profile and company fields can be absent; timestamps indicate when the snapshot was fetched.

Automated tests mock all external API calls. No AoN API key is required, and the app does not poll the API.

## Current modules

- `src/config/env.ts` validates shared settings and requires a Groq API key when starting the bot.
- `src/database/migrations.ts` applies versioned, transactional schema migrations. `src/database/repositories.ts` provides settings, session, and message CRUD.
- `src/knowledge/retrieval.ts` discovers Markdown recursively, preserves relative source and heading, splits oversized sections, normalizes Arabic text, and ranks matching chunks with a simple lexical score. It is a lightweight local retriever, not embedding-based RAG.
- `src/assistant/service.ts` retrieves relevant chunks, loads recent messages scoped to the guild and user, calls the answer provider, and persists the exchange.
- `src/discord/commands.ts` registers global `/ping` and `/ask`; `src/discord/client.ts` handles them, defers long requests, and splits long responses under Discord's message limit.
- `src/groq/client.ts` sends OpenAI-compatible chat completions to Groq's API, caps retrieved context and output, and classifies provider failures without retry loops.
- `src/aon-api/client.ts` validates the public profile, statistics, and company fields used by the app; applies 30-second caching, request deduplication, a conservative local request pace, timeout, and bounded 429 retry handling.
- `src/aon-api/linking.ts` handles time-limited player-link confirmation, link conflicts, and unverified associations. `src/aon-api/analysis.ts` builds bounded player context and keeps classification logic separate.
- Migration 3 creates `linked_players`; it runs automatically without discarding existing database data.

The selected Qwen model's published free-plan limits are currently 30 requests/minute, 1,000 requests/day, 8,000 tokens/minute, and 200,000 tokens/day. Limits can vary by account and may change; check the Groq console. The app sends at most four retrieved chunks, trims recent history, caps completions at 800 tokens, honors `Retry-After` in its user-facing response, and makes no automatic retries or paid-model fallback.

Put trusted Markdown files in `knowledge/`; the `.gitignore` rule prevents those files from being committed accidentally. Answers are instructed to rely on retrieved source material and acknowledge when it is insufficient. Retrieval is lightweight lexical matching, so verify knowledge coverage and answer quality before relying on it for authoritative game guidance.

