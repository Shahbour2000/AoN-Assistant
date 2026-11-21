# Setup guide (free-only)

Goal: run the bot on **free AI tiers only**, with no card, no credits and no pay-as-you-go anywhere.
Order of use: **Groq** (Qwen 3.8 27B) -> **Groq** (gpt-oss-120b, separate quota) -> **Cloudflare Workers AI** (gpt-oss-120b) -> **OpenRouter** (Gemma 4, only 50 requests/day). Embeddings: **Cloudflare bge-m3**.

## 0. Rules that keep it free
- Never enter a credit card, buy credits or upgrade a plan on Groq, Cloudflare or OpenRouter for this bot.
- The bot only accepts model IDs listed in `src/llm/free-models.ts`. Anything else (a typo, a paid model) stops startup with an error before any request is sent.
- When a free quota runs out the provider returns an error; the bot switches to the next provider and does not retry the exhausted one until its limit resets.
- Keep keys only in `.env`. Never post them anywhere. If one leaks, delete it on the provider's site and create a new one.
- Privacy: free tiers may log or use prompts (OpenRouter free models especially). Tell your members that questions go to these services.

## 1. Groq (you already have this)
Check once at https://console.groq.com -> Settings -> Billing that the plan says **Free** (not Developer). Do not upgrade.

## 2. Cloudflare Workers AI (new)
1. Free account at https://dash.cloudflare.com (stay on the **Free** plan; never subscribe to Workers Paid).
2. Copy your **Account ID** -> `CLOUDFLARE_ACCOUNT_ID=`.
3. https://dash.cloudflare.com/profile/api-tokens -> Create Token -> **Workers AI** template -> copy the token -> `CLOUDFLARE_API_TOKEN=`.
Free allowance: 10,000 neurons/day (resets 00:00 UTC), shared by chat and embeddings. When it is used up, calls fail; they are not billed.

## 3. OpenRouter (optional, last resort)
Create a key at https://openrouter.ai/keys -> `OPENROUTER_API_KEY=`. Do not buy credits. Free models are limited to 20 requests/minute and 50 requests/day in total. OpenRouter is optional and is always the LAST provider in the automatic chain; free-model prompts may be handled by the upstream provider under its own data policy, and failed requests also count toward the 50/day. If you do not want it, leave the key empty (and remove it from `LLM_BACKUP` if you set that yourself).

Automatic chain: leave `LLM_PRIMARY=` and `LLM_BACKUP=` BOTH blank and the bot uses every provider that has credentials, in this order: Groq main (`GROQ_MODEL`) -> Cloudflare chat (needs token AND account id) -> Groq secondary (`openai/gpt-oss-120b`, or `qwen/qwen3.8-27b` if that is already the main) -> OpenRouter free. The startup log prints the final chain, and `npm run check:providers` prints it too.

## 4. Add these lines to your existing `.env` (do not delete anything)
```
CLOUDFLARE_ACCOUNT_ID=
CLOUDFLARE_API_TOKEN=
OPENROUTER_API_KEY=
LLM_PRIMARY=groq:qwen/qwen3.8-27b
LLM_BACKUP=groq:openai/gpt-oss-120b,cloudflare:@cf/openai/gpt-oss-120b,openrouter:google/gemma-4-26b-a4b-it:free
EMBEDDING_PROVIDER=cloudflare
```
Fill in the three keys. Leave `GROQ_API_KEY` and `GROQ_MODEL` as they are. A backup whose key is missing is skipped with a warning.

## 5. Check
```
npm install
npm run typecheck
npm test
npm run check:providers
```
`check:providers` makes real calls (3 per chat model; OpenRouter counts against its 50/day) and reports per model: chat, **tool calling**, Arabic reply; and for embeddings an English-Arabic similarity test. Only models that print tool calling OK should be primary. Delete the first `embeddings.json` in `data/` if you switch embedding models (it is rebuilt automatically).

## 6. Run
```
npm run dev
```
Logs show `LLM request served` with `provider` and `model` for every request, and `LLM provider failed, trying next` (with the cool-down) on failover. At startup the log must say `mode: 'hybrid'`.

## 7. Expected capacity (estimates, not measured)
Each answer uses roughly 1-3 model calls of about 4-7K tokens. Groq's 8K tokens/minute makes it slow for big prompts; its daily limit is per model. Rough free capacity: tens of questions per day in total. If everything is exhausted the bot replies that it is temporarily unavailable.

## 8. Billing checklist
- Groq plan = Free. Cloudflare plan = Free. OpenRouter: zero credits purchased.
- Never put model IDs outside the allowlist in `.env`; the bot refuses them.
- `.env` must be in `.gitignore`.
