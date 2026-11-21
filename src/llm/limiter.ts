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

  /** Reserve capacity for one request. Waits briefly when that is enough, otherwise throws a rate_limit error. */
  async acquire(estimatedTokens: number, provider: string): Promise<void> {
    const started = this.now();
    for (;;) {
      const current = this.now();
      const wait = this.waitTime(current, estimatedTokens);
      if (wait === 0) { this.events.push({ at: current, tokens: estimatedTokens }); return; }
      if (wait === Infinity) throw new LlmError('rate_limit', `Local ${provider} limit: one request of about ${estimatedTokens} tokens is larger than the provider's per-minute/per-day token limit (${this.limits.tpm ?? '-'}/${this.limits.tpd ?? '-'}). Use a provider with a larger limit or shorten the prompt.`, { provider, retryAfterSeconds: 60 });
      if (current - started + wait > this.maxWaitMs) throw new LlmError('rate_limit', `Local ${provider} limit reached`, { provider, retryAfterSeconds: Math.ceil(wait / 1000) });
      await this.sleep(wait);
    }
  }

  /** Record actual usage once known (replaces the estimate for the most recent event). */
  settle(actualTokens: number, estimatedTokens: number): void {
    const last = this.events[this.events.length - 1];
    if (last && last.tokens === estimatedTokens) last.tokens = actualTokens;
  }

  private waitTime(now: number, tokens: number): number {
    const day = 24 * 3_600_000;
    while (this.events.length && this.events[0]!.at <= now - day) this.events.shift();
    const { rpm, tpm, rpd, tpd } = this.limits;
    let wait = 0;
    const inWindow = (ms: number) => this.events.filter((event) => event.at > now - ms);
    if (rpm !== undefined) {
      const recent = inWindow(60_000);
      if (recent.length >= rpm) wait = Math.max(wait, recent[recent.length - rpm]!.at + 60_000 - now);
    }
    if (tpm !== undefined) {
      if (tokens > tpm) return Infinity;
      const recent = inWindow(60_000);
      let used = recent.reduce((sum, event) => sum + event.tokens, 0);
      for (const event of recent) { if (used + tokens <= tpm) break; used -= event.tokens; wait = Math.max(wait, event.at + 60_000 - now); }
    }
    if (rpd !== undefined && this.events.length >= rpd) wait = Math.max(wait, this.events[this.events.length - rpd]!.at + day - now);
    if (tpd !== undefined) {
      if (tokens > tpd) return Infinity;
      let used = this.events.reduce((sum, event) => sum + event.tokens, 0);
      for (const event of this.events) { if (used + tokens <= tpd) break; used -= event.tokens; wait = Math.max(wait, event.at + day - now); }
    }
    return Math.max(0, Math.ceil(wait));
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
      throw new LlmError('rate_limit', `Local ${provider} free-neuron budget used up for today (${Math.round(this.used)}/${this.dailyLimit}); it resets at 00:00 UTC`, { provider, retryAfterSeconds: secondsUntilUtcMidnight(this.now()) });
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
