# AoN Assistant

Standalone Discord assistant foundation for Age of Nations. The project targets Node.js 22+, TypeScript, Discord.js, Google's official Gen AI SDK, and SQLite.

## Current phase

The first runnable bot phase provides `/ping` and `/ask`, Gemini responses grounded in locally retrieved Markdown, and persisted per-user/per-server conversation history in SQLite. Ticket channels and administrative commands are not implemented.

## Setup

1. Install Node.js 22 or newer and npm.
2. Run `npm install`.
3. Copy `.env.example` to `.env` and configure the Discord and Gemini values below. Foundation tests do not require credentials.
4. Add trusted `.md` files under `knowledge/`.
5. Run `npm run typecheck`, then `npm run dev`.

## Environment variables

| Variable | Purpose |
| --- | --- |
| `DISCORD_TOKEN` | Discord bot token |
| `DISCORD_CLIENT_ID` | Discord application/client ID used to register slash commands |
| `GEMINI_API_KEY` | Google AI Studio API key |
| `GEMINI_MODEL` | Gemini model name (defaults to `gemini-2.5-flash`) |
| `DATABASE_PATH` | SQLite database file path |
| `KNOWLEDGE_DIR` | Markdown knowledge directory |
| `LOG_LEVEL` | `debug`, `info`, `warn`, or `error` |

Keep `.env` private. Never commit bot tokens or API keys. Knowledge Markdown files are ignored by Git; `knowledge/README.md` is tracked.

## Commands

- `npm run dev` — run the startup check in watch mode.
- `npm run build` — compile to `dist/`.
- `npm start` — run the compiled startup check.
- `npm run typecheck` — validate TypeScript without emitting files.
- `npm test` — run foundation tests for config, SQLite, and knowledge retrieval.

## Run the bot

1. Create a Discord application and bot in the Discord Developer Portal.
2. Invite it to your server with the `bot` and `applications.commands` scopes and permission to view/send messages.
3. Create a Gemini API key and put it in `.env`; never commit that file.
4. Add game Markdown sources under `knowledge/`.
5. Run `npm run dev` for development or `npm run build && npm start` for compiled execution.
6. Use `/ping` to check availability and `/ask question:<your question>` to ask about the game.

## Current modules

- `src/config/env.ts` validates shared settings and exposes explicit requirements for future Discord/Gemini features.
- `src/database/migrations.ts` applies versioned, transactional schema migrations. `src/database/repositories.ts` provides settings, session, and message CRUD.
- `src/knowledge/retrieval.ts` discovers Markdown recursively, preserves relative source and heading, splits oversized sections, normalizes Arabic text, and ranks matching chunks with a simple lexical score. It is a lightweight local retriever, not embedding-based RAG.
- `src/assistant/service.ts` retrieves relevant chunks, loads recent messages scoped to the guild and user, calls the answer provider, and persists the exchange.
- `src/discord/commands.ts` registers global `/ping` and `/ask`; `src/discord/client.ts` handles them, defers long requests, and splits long responses under Discord's message limit.
- `src/gemini/client.ts` uses the official Google Gen AI SDK and classifies API failures into safe user-facing categories.

Put trusted Markdown files in `knowledge/`; the `.gitignore` rule prevents those files from being committed accidentally. Answers are instructed to rely on retrieved source material and acknowledge when it is insufficient. Retrieval is lightweight lexical matching, so verify knowledge coverage and answer quality before relying on it for authoritative game guidance.

## Planned modules

Administrative slash commands will configure per-server ticket category, entry post and customizable embed, inactivity duration, current settings, manual session closure, knowledge reload, and usage statistics. Ticket handlers will create private channels, enforce one active session per user per server, retain conversation context, and close sessions on request or inactivity.
