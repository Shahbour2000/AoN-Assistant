# Setup guide (beginner friendly)

Goal: run the bot with **free** AI services only, without adding a payment card anywhere.
Plan: **Mistral** (main brain) → **Gemini** (backup + search embeddings) → optional **Groq** (extra backup) and **Cloudflare** (extra-safe embeddings).
Website menus change from time to time; if a button has a slightly different name, look for the closest one.

## 0. Rules that keep it free
- Never type a credit card into any of these sites for this bot. If a page asks for a card to "upgrade", close it.
- A free key that runs out of quota simply returns an error ("rate limit") — the bot then waits or uses the backup. It cannot bill you.
- Keep keys secret: they go only in the file `.env` on your computer/server. Never post them in Discord, GitHub, screenshots or chat. If one leaks, delete it on the provider's site and create a new one.
- Privacy: free tiers may use what you send them. Mistral's free "Experiment" plan: *"API requests … may be used to train Mistral's models."* Gemini's free tier: Google uses inputs/outputs to improve products and humans may review them; **you must be 18+, the API must not be offered to under-18 users, and in the EEA/UK/Switzerland Google requires paid services**. Groq: does not retain inference data by default (can be switched to zero retention in its settings). Tell your server members that their questions go to these services.

## 1. Mistral key (main model) — free, no card
1. Open https://console.mistral.ai and create an account (email or Google).
2. Create/choose your workspace and pick the **Experiment** (free) plan. It asks you to verify a **phone number**; no card is needed.
3. Open **API Keys** in the left menu → **Create new key** → name it `aon-bot` → copy the key (shown once).
4. In `.env`: `MISTRAL_API_KEY=` + the key.
5. Free limits are shown inside the console (Admin → Limits); Mistral does not publish them on its help page.

## 2. Gemini key (backup + embeddings) — free, no card
1. Open https://aistudio.google.com/apikey and sign in with a Google account (18+).
2. Click **Create API key** → choose **Create API key in new project** (a brand-new project has no billing).
3. **Do not** click anything called "Set up billing" / "Upgrade". Free-tier usage is limited per project, and your limits are listed in AI Studio (Dashboard → rate limits).
4. Copy the key. In `.env`: `GEMINI_API_KEY=` + the key.

## 3. Optional: Groq key (extra backup)
1. Open https://console.groq.com → sign up → **API Keys** → **Create API Key**.
2. In `.env`: `GROQ_API_KEY=` + the key. The free plan allows only 8,000 tokens/minute, so it is a last-resort backup, never the main model.
3. Optional privacy: in Groq console **Data Controls**, turn on **Zero Data Retention**.

## 4. Optional: Cloudflare (safest embeddings)
The free plan gives 10,000 "neurons" a day and **stops** (does not bill) when they are used up.
1. Create a free account at https://dash.cloudflare.com (no card needed for the free plan).
2. Copy your **Account ID** (shown on the account home page / in the right-hand sidebar of Workers & Pages). Put it in `.env` as `CLOUDFLARE_ACCOUNT_ID=`.
3. Go to https://dash.cloudflare.com/profile/api-tokens → **Create Token** → use the **Workers AI** template (or a custom token with *Workers AI: Read* and *Edit*) → create → copy the token → `CLOUDFLARE_API_TOKEN=`.
4. If you want Cloudflare instead of Gemini for embeddings: `EMBEDDING_PROVIDER=cloudflare`. Otherwise leave `auto`.

## 5. Create your `.env`
```
cp .env.example .env        # Windows: copy .env.example .env
```
Open `.env` in a text editor and replace the placeholder values (`put-...-here`) with your real keys. Keep these lines:
```
LLM_PRIMARY=mistral:mistral-large-latest
LLM_BACKUP=gemini:gemini-3.1-flash-lite,groq:qwen/qwen3.8-27b
EMBEDDING_PROVIDER=auto
```
Leave `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `CLOUDFLARE_*` empty if you skipped those steps (missing backups are skipped automatically).

## 6. Check everything
```
npm install
npm run typecheck
npm test
npm run check:providers
```
`npm run check:providers` calls each provider with a tiny test and prints ✓ / ✗:
- ✓ chat model ids exist (if it says `NOT LISTED` for `mistral-large-latest`, copy an id from the list it prints into `LLM_PRIMARY`);
- ✓ one chat call works;
- ✓ embeddings work, and **English↔Arabic similarity is higher than for unrelated text** (this is the cross-language search test).

If embeddings say `NONE`, search is keyword-only: Arabic questions work, English questions may miss Arabic wiki text.

## 7. Run the bot, then evaluate
```
npm run dev                 # development
npm run build && npm start  # production
npm run eval                # real conversation tests (uses some free quota). EVAL_PACE_SECONDS=10 npm run eval  for strict limits
```
At startup the log must say `mode: 'hybrid'` and `embedder: gemini:...` (or cloudflare/mistral). `mode: 'keyword'` means embeddings are not configured.
The first start embeds the wiki once (about 270 passages) and saves it in `data/embeddings.json`; later starts reuse it.

## 8. Avoid accidental billing — checklist
- Mistral: stay on **Experiment**; do not switch to a paid plan.
- Gemini: use a key from a project **without billing**; never link a billing account to it.
- Never add a card to Groq/Cloudflare/OpenRouter for this bot (OpenRouter's free models are capped at 50 requests/day unless you buy credits).
- Do not put paid model names in `LLM_PRIMARY`/`LLM_BACKUP`. The bot only accepts the providers listed above, and OpenRouter models must end in `:free`.
- Check `.gitignore` contains `.env` before every `git push`.
