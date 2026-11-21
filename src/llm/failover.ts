import { logger } from '../logging/logger.js';
import { LlmError, type ChatRequest, type ChatResponse, type LlmProvider } from './types.js';

export interface FailoverOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** When every provider is only briefly unavailable, wait up to this long (once) instead of failing the player's question. Default 45 s. */
  maxWaitMs?: number;
}

interface Cooldown { until: number; reason: string; }

/**
 * Ordered provider chain. The first provider is the primary; later ones are used when an earlier one fails in a way another
 * provider could fix. Every provider in the chain is one the operator configured (or that has a key in `.env`), and nothing is ever
 * switched to a paid service: each provider is itself restricted to the free-model allowlist.
 *
 * A provider that failed is SKIPPED until its cool-down ends (a rate limit is honoured for as long as the provider, or our own local
 * limiter, says; other failures for a short time). When every provider is cooling down for only a short while, the chain waits once
 * and retries; otherwise it fails with one error that explains the situation for each provider.
 */
export class FailoverProvider implements LlmProvider {
  readonly id: string;
  private readonly cooldowns = new Map<LlmProvider, Cooldown>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  constructor(private readonly providers: LlmProvider[], nowOrOptions: (() => number) | FailoverOptions = {}) {
    if (!providers.length) throw new Error('At least one LLM provider is required');
    const options = typeof nowOrOptions === 'function' ? { now: nowOrOptions } : nowOrOptions;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxWaitMs = options.maxWaitMs ?? 45_000;
    this.id = providers.map((provider) => provider.id).join(' -> ');
  }

  /** Providers that are usable right now, with their remaining cool-down for the others (used by diagnostics and tests). */
  status(): Array<{ provider: string; availableInSeconds: number; reason?: string }> {
    const now = this.now();
    return this.providers.map((provider) => { const c = this.cooldowns.get(provider); const left = c && c.until > now ? Math.ceil((c.until - now) / 1000) : 0; return { provider: provider.id, availableInSeconds: left, ...(left ? { reason: c!.reason } : {}) }; });
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    let waited = false;
    for (;;) {
      const errors: LlmError[] = [];
      const skipped: Array<{ provider: LlmProvider; cooldown: Cooldown }> = [];
      for (const provider of this.providers) {
        const cooldown = this.cooldowns.get(provider);
        if (cooldown && cooldown.until > this.now()) { skipped.push({ provider, cooldown }); continue; }
        try {
          const response = await provider.chat(request);
          if (provider !== this.providers[0]) logger.info('LLM request served by a backup provider', { servedBy: `${response.provider}:${response.model}`, primary: this.providers[0]!.id, skippedOrFailed: this.providers.slice(0, this.providers.indexOf(provider)).map((p) => p.id) });
          return response;
        } catch (error) {
          if (!(error instanceof LlmError)) throw error;
          errors.push(error);
          const ms = cooldownMs(error);
          const reason = describe(error);
          this.cooldowns.set(provider, { until: this.now() + ms, reason });
          logger.warn('LLM provider failed, trying next', { provider: provider.id, kind: error.kind, source: error.source, reachedProvider: error.details.reachedProvider, status: error.status, limit: error.details.limit, requestedTokens: error.details.requestedTokens, usedTokens: error.details.usedTokens, maxTokens: error.details.maxTokens, retryAfterSeconds: error.retryAfterSeconds, cooldownSeconds: Math.round(ms / 1000), detail: error.details.providerMessage });
        }
      }

      // Nobody could answer. If the soonest recovery is short, wait once for it instead of failing the player's question.
      const now = this.now();
      const remaining = this.providers.map((provider) => Math.max(0, (this.cooldowns.get(provider)?.until ?? 0) - now));
      const soonest = Math.min(...remaining);
      const onlyLimits = [...errors, ...skipped.map((s) => s.cooldown)].every((item) => item instanceof LlmError ? item.kind === 'rate_limit' : /^rate_limit/u.test(item.reason));
      if (!waited && onlyLimits && soonest > 0 && soonest <= this.maxWaitMs) {
        waited = true;
        logger.info('All LLM providers are briefly rate limited; waiting once for the soonest one', { waitSeconds: Math.ceil(soonest / 1000), providers: this.status() });
        await this.sleep(soonest + 50);
        continue;
      }
      throw this.exhausted(errors, remaining);
    }
  }

  private exhausted(errors: LlmError[], remainingMs: number[]): LlmError {
    const summary = this.status();
    // A rate limit anywhere in the chain beats generic failures: it tells the player a retry will work.
    const anyLimit = errors.some((error) => error.kind === 'rate_limit') || summary.some((s) => s.reason && /^rate_limit/u.test(s.reason));
    const candidates = remainingMs.filter((ms) => ms > 0).map((ms) => ms / 1000);
    const retryAfterSeconds = candidates.length ? Math.max(1, Math.ceil(Math.min(...candidates))) : 60;
    const detail = summary.map((s) => `${s.provider}${s.reason ? ` [${s.reason}, ${s.availableInSeconds}s]` : ''}`).join('; ');
    logger.error('All LLM providers unavailable', { providers: summary, retryAfterSeconds });
    const best = errors.find((error) => error.kind !== 'rate_limit') ?? errors[0];
    const kind = anyLimit ? 'rate_limit' : (best?.kind ?? 'unavailable');
    return new LlmError(kind, `All LLM providers unavailable: ${detail}`, { ...(best?.details ?? {}), source: 'all_providers', retryAfterSeconds, providerMessage: detail });
  }
}

function describe(error: LlmError): string { return `${error.kind === 'rate_limit' ? 'rate_limit' : error.kind}${error.source ? `/${error.source}` : ''}`; }

const DAY_MS = 24 * 3_600_000;
function cooldownMs(error: LlmError): number {
  const requested = (error.retryAfterSeconds ?? 20) * 1000;
  // A rate limit is honoured for as long as the provider (or our own limiter) says, up to a day.
  if (error.kind === 'rate_limit') return Math.min(Math.max(requested, 5_000), DAY_MS);
  // Provider-specific rejections (unsupported parameter, context too large for a small model) are retried after a couple of minutes.
  if (error.kind === 'bad_request') return 120_000;
  return Math.min(Math.max(requested, 5_000), error.kind === 'unauthorized' || error.kind === 'forbidden' ? 600_000 : 120_000);
}
