# Setup guide (free-only)

Goal: a responsive Discord assistant on **free AI tiers only**: no card, no credits, no pay-as-you-go anywhere.

## How the free chain works
Leave `LLM_PRIMARY` and `LLM_BACKUP` **blank** in `.env`. The bot then builds its chain from the API keys that are present, in this order:

1. **Groq** main model (`GROQ_MODEL`, default `qwen/qwen3.8-27b`)
2. **Cloudflare Workers AI** `@cf/openai/gpt-oss-120b` (needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN`)
3. **Groq** `openai/gpt-oss-120b` (a separate quota bucket from the main model)
4. **OpenRouter** `google/gemma-4-26b-a4b-it:free` (needs `OPENROUTER_API_KEY`; only 50 requests/day, so last)

A provider without its key is **not available** and is not used. A provider that hits a limit is **skipped until its cool-down ends**, and the next one answers immediately, so a player does not wait while another free provider is available. A player is asked to wait only when every provider in the chain is limited at the same moment. Embeddings: **Cloudflare bge-m3**.

To choose the order yourself: `LLM_PRIMARY=groq:qwen/qwen3.8-27b`, `LLM_BACKUP=cloudflare:@cf/openai/gpt-oss-120b,auto` (`auto` appends every other provider that has a key, without duplicates).

## 0. Rules that keep it free
- Never enter a credit card, buy credits or upgrade a plan on Groq, Cloudflare or OpenRouter for this bot.
- The bot only accepts model IDs listed in `src/llm/free-models.ts`. Anything else (a typo, a paid model) stops startup before any request is sent.
- When a free quota runs out the provider returns an error; the bot moves on to the next provider and does not call the exhausted one until its limit resets.
- Keep keys only in `.env`. Never post them anywhere. If one leaks, delete it on the provider's site and create a new one.
- Privacy: free tiers may log or use prompts (OpenRouter free models especially). Tell your members that questions go to these services.

## 1. Discord
`DISCORD_TOKEN=` and `DISCORD_CLIENT_ID=` (unchanged from before). Defaults you normally leave alone: `DATABASE_PATH=./data/aon-assistant.sqlite`, `KNOWLEDGE_DIR=./knowledge`, `LOG_LEVEL=info`, `VALIDATION_MODE=basic` (`llm` adds a model call per answer and uses more quota).

## 2. Groq
`GROQ_API_KEY=` (https://console.groq.com -> API Keys) and optionally `GROQ_MODEL=`.
Check once at https://console.groq.com -> Settings -> Billing that the plan says **Free**. Do not upgrade. Free limits per model: 30 requests/min, 1,000 requests/day, **8,000 tokens/min**, 200,000 tokens/day.

## 3. Cloudflare Workers AI (strongly recommended: it is what keeps the bot responsive)
1. Free account at https://dash.cloudflare.com (stay on the **Free** plan; never subscribe to Workers Paid).
2. **Account ID** -> `CLOUDFLARE_ACCOUNT_ID=`.
3. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> **Workers AI** template -> `CLOUDFLARE_API_TOKEN=`.
Free allowance: 10,000 neurons/day (resets 00:00 UTC), shared by chat and embeddings. When it is used up, calls fail; they are not billed. The bot keeps a local cap (`CLOUDFLARE_DAILY_NEURON_BUDGET`, default 9,000).

## 4. OpenRouter (optional)
Key at https://openrouter.ai/keys -> `OPENROUTER_API_KEY=`. Do not buy credits. Free models: 20 requests/minute, 50 requests/day. Leave blank to not use it.

## 5. What to put in your existing `.env`
Keep everything you already have. Add only what is missing (values are yours, never paste them anywhere):
```
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
OPENROUTER_API_KEY=
EMBEDDING_PROVIDER=auto
```
and make sure `LLM_PRIMARY=` and `LLM_BACKUP=` are **blank or deleted** (this is the change that gives you more than one provider). Blank values are treated as "not set".

## 6. Check
```
npm install
npm run typecheck
npm test
npm run check:providers
npm run eval:retrieval
```
`check:providers` makes real calls and prints, **per model in the chain**, chat / tool calling / Arabic as `OK`, `FAILED` or `not tested`, lists providers without keys as "not configured", and ends with a summary table. It costs 3 requests per chat model (OpenRouter counts against its 50/day), so run it sparingly. `eval:retrieval` runs the wiki retrieval cases in keyword mode and with the real Cloudflare embedder (the first run embeds ~270 passages once; they are cached in `data/embeddings.json`). Delete that file if you change `EMBEDDING_MODEL`.

`npm run eval` (live scenarios, uses quota) can be paced with `EVAL_PACE_SECONDS=10`.

## 7. Run
```
npm run dev
```
At startup the log lists the chain. Per question you will see `Agent request prepared` (tool set, passages found, approximate prompt size), `LLM request served` (provider, model, tokens), and, when something is limited, `LLM provider failed, trying next` with `source` (`local_limiter`, `provider_429`, `daily_quota`...), `reachedProvider`, the limit, requested/used/max tokens and the cool-down seconds. API keys are never logged.

## 8. Expected capacity (estimates, not measured live)
A wiki question now costs about 1.8-2.4K prompt tokens (it was about 5K) in one model call, and a greeting about 0.3K. Groq's 8K tokens/min therefore fits roughly 3 wiki questions per minute per Groq model, and Cloudflare/the second Groq model take the overflow. Repeated identical questions in the same conversation are answered from a cache with no model call. Free daily allowances are still finite: heavy use by many players in one day can exhaust all providers; the bot then says so, with the real remaining time.

## 9. Billing checklist
- Groq plan = Free. Cloudflare plan = Free. OpenRouter: zero credits purchased.
- Model IDs outside the allowlist are refused.
- `.env` must stay in `.gitignore`.
