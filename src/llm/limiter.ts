import { LlmError } from './types.js';

export interface ProviderLimits { rpm?: number; tpm?: number; rpd?: number; tpd?: number; }

/**
 * Local sliding-window limiter that mirrors a provider's published free-tier limits. It prevents us from
 * burning requests that are certain to 429 and lets the failover layer pick another provider immediately.
 * Limits are *ceilings we respect*, never something we try to exceed. Unset limits are not enforced.
 */
export class LocalLimiter {
  private readonly events: Array<{ at: number; tokens: number }> = [];
  constructor(private readonly limits: ProviderLimits, private readonly now: () => number = Date.now, private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), private readonly maxWaitMs = 25_000) {}

  /** Reserve capacity for one request. Waits briefly when that is enough, otherwise throws a rate_limit error that says exactly which limit blocked it. */
  async acquire(estimatedTokens: number, provider: string, model = ''): Promise<void> {
    const started = this.now();
    for (;;) {
      const current = this.now();
      const block = this.blocker(current, estimatedTokens);
      if (!block) { this.events.push({ at: current, tokens: estimatedTokens }); return; }
      const label = model ? `${provider}:${model}` : provider;
      const base = { provider, ...(model ? { model } : {}), source: 'local_limiter' as const, reachedProvider: false, limit: block.limit, requestedTokens: estimatedTokens, usedTokens: block.used, maxTokens: block.max };
      if (block.wait === Infinity) throw new LlmError('rate_limit', `Local limiter (${label}): one request of about ${estimatedTokens} tokens is larger than the ${block.limit.toUpperCase()} limit (${block.max}). Use a provider with a larger limit or shorten the prompt.`, { ...base, retryAfterSeconds: 60 });
      if (current - started + block.wait > this.maxWaitMs) {
        const retryAfterSeconds = Math.ceil(block.wait / 1000);
        throw new LlmError('rate_limit', `Local limiter (${label}): ${block.limit.toUpperCase()} limit - this request needs about ${estimatedTokens}, ${block.used} of ${block.max} already used in the window; free again in ${retryAfterSeconds}s. Nothing was sent to the provider.`, { ...base, retryAfterSeconds });
      }
      await this.sleep(block.wait);
    }
  }

  /** Record actual usage once known (replaces the estimate for the most recent event). */
  settle(actualTokens: number, estimatedTokens: number): void {
    const last = this.events[this.events.length - 1];
    if (last && last.tokens === estimatedTokens) last.tokens = actualTokens;
  }

  private blocker(now: number, tokens: number): { wait: number; limit: string; used: number; max: number } | undefined {
    const day = 24 * 3_600_000;
    while (this.events.length && this.events[0]!.at <= now - day) this.events.shift();
    const { rpm, tpm, rpd, tpd } = this.limits;
    let worst: { wait: number; limit: string; used: number; max: number } | undefined;
    const consider = (wait: number, limit: string, used: number, max: number) => { if (wait > 0 && (!worst || wait > worst.wait)) worst = { wait: wait === Infinity ? Infinity : Math.ceil(wait), limit, used, max }; };
    const inWindow = (ms: number) => this.events.filter((event) => event.at > now - ms);
    if (rpm !== undefined) {
      const recent = inWindow(60_000);
      if (recent.length >= rpm) consider(recent[recent.length - rpm]!.at + 60_000 - now, 'rpm', recent.length, rpm);
    }
    if (tpm !== undefined) {
      if (tokens > tpm) return { wait: Infinity, limit: 'tpm', used: 0, max: tpm };
      const recent = inWindow(60_000);
      const total = recent.reduce((sum, event) => sum + event.tokens, 0);
      let used = total, wait = 0;
      for (const event of recent) { if (used + tokens <= tpm) break; used -= event.tokens; wait = Math.max(wait, event.at + 60_000 - now); }
      consider(wait, 'tpm', total, tpm);
    }
    if (rpd !== undefined && this.events.length >= rpd) consider(this.events[this.events.length - rpd]!.at + day - now, 'rpd', this.events.length, rpd);
    if (tpd !== undefined) {
      if (tokens > tpd) return { wait: Infinity, limit: 'tpd', used: 0, max: tpd };
      const total = this.events.reduce((sum, event) => sum + event.tokens, 0);
      let used = total, wait = 0;
      for (const event of this.events) { if (used + tokens <= tpd) break; used -= event.tokens; wait = Math.max(wait, event.at + day - now); }
      consider(wait, 'tpd', total, tpd);
    }
    return worst;
  }
}

/** Seconds from `now` until the next 00:00 UTC (when Cloudflare's free neuron allowance resets). */
export function secondsUntilUtcMidnight(now: number = Date.now()): number {
  const next = Date.UTC(new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate() + 1);
  return Math.max(1, Math.ceil((next - now) / 1000));
}

/**
 * Account-wide daily budget shared by every Workers AI chat model and the embedder (they all draw from the same
 * 10,000 free neurons per day). It is deliberately set below the real allowance. Cloudflare itself hard-stops at the
 * limit instead of billing, so this budget only avoids wasted calls — it is not what protects you from charges.
 */
export class NeuronBudget {
  private day = '';
  private used = 0;
  constructor(private readonly dailyLimit: number, private readonly now: () => number = Date.now) {}

  private roll(): void {
    const today = new Date(this.now()).toISOString().slice(0, 10);
    if (today !== this.day) { this.day = today; this.used = 0; }
  }

  /** Reserve `neurons`; throws a rate_limit error (with a retry time at the next UTC midnight) when the budget is spent. */
  reserve(neurons: number, provider: string): void {
    this.roll();
    if (this.used + neurons > this.dailyLimit) {
      throw new LlmError('rate_limit', `Local ${provider} free-neuron budget used up for today (${Math.round(this.used)}/${this.dailyLimit}); it resets at 00:00 UTC`, { provider, source: 'local_budget', reachedProvider: false, limit: 'neurons', usedTokens: Math.round(this.used), maxTokens: this.dailyLimit, retryAfterSeconds: secondsUntilUtcMidnight(this.now()) });
    }
    this.used += neurons;
  }

  /** Replace an estimate with the real figure (or release it entirely with actual = 0 after a failed call). */
  settle(actual: number, estimated: number): void {
    this.roll();
    this.used = Math.max(0, this.used - estimated + actual);
  }

  get usedToday(): number { this.roll(); return this.used; }
}
