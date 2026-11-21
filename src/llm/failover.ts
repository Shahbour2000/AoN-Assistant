import { logger } from '../logging/logger.js';
import { LlmError, type ChatRequest, type ChatResponse, type LlmProvider } from './types.js';

/**
 * Ordered provider chain. The first provider is the primary; later ones are only used when the earlier one
 * fails in a way another provider could fix (rate limit, timeout, outage, bad key). Every provider in the chain
 * is one the operator listed explicitly in configuration, so private conversations never reach a provider the
 * operator did not choose, and nothing is ever switched to a paid service automatically.
 */
export class FailoverProvider implements LlmProvider {
  readonly id: string;
  private readonly unavailableUntil = new Map<LlmProvider, number>();
  constructor(private readonly providers: LlmProvider[], private readonly now: () => number = Date.now) {
    if (!providers.length) throw new Error('At least one LLM provider is required');
    this.id = providers.map((provider) => provider.id).join(' -> ');
  }

  async chat(request: ChatRequest): Promise<ChatResponse> {
    const errors: LlmError[] = [];
    const current = this.now();
    const ordered = [...this.providers].sort((a, b) => Number((this.unavailableUntil.get(a) ?? 0) > current) - Number((this.unavailableUntil.get(b) ?? 0) > current));
    for (const provider of ordered) {
      try {
        const response = await provider.chat(request);
        if (provider !== this.providers[0]) logger.info('LLM request served by a backup provider', { servedBy: `${response.provider}:${response.model}`, primary: this.providers[0]!.id });
        return response;
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        errors.push(error);
        // A bad request is our bug (or an unsupported feature), not the provider's availability: try the next provider once, but do not cool it down.
        // Cool-down: a rate limit is honoured for as long as the provider (or our own daily budget) says, up to a day, so an exhausted
        // free quota is not hammered with retries; other failures are retried again after at most 2 minutes (10 for a bad key).
        if (error.kind !== 'bad_request') this.unavailableUntil.set(provider, this.now() + cooldownMs(error));
        logger.warn('LLM provider failed, trying next', { provider: provider.id, kind: error.kind, status: error.status, retryAfterSeconds: error.retryAfterSeconds, cooldownSeconds: error.kind === 'bad_request' ? 0 : Math.round(cooldownMs(error) / 1000), detail: error.details.providerMessage });
        if (!error.failoverEligible && error.kind !== 'bad_request') break;
      }
    }
    // Prefer reporting the most useful error: a rate limit with retry-after beats generic failures.
    const best = errors.find((error) => error.kind === 'rate_limit') ?? errors[errors.length - 1]!;
    throw new LlmError(best.kind, errors.length > 1 ? `All LLM providers failed (${errors.map((e) => `${e.details.provider ?? '?'}:${e.kind}`).join(', ')})` : best.message, { ...best.details });
  }
}

const DAY_MS = 24 * 3_600_000;
function cooldownMs(error: LlmError): number {
  const requested = (error.retryAfterSeconds ?? 20) * 1000;
  if (error.kind === 'rate_limit') return Math.min(Math.max(requested, 5_000), DAY_MS);
  return Math.min(Math.max(requested, 5_000), error.kind === 'unauthorized' || error.kind === 'forbidden' ? 600_000 : 120_000);
}
