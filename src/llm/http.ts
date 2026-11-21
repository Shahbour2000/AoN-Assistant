import { LlmError } from './types.js';

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export function redact(text: string): string {
  return text.replace(/(Bearer\s+)[^\s"']+/giu, '$1[REDACTED]').replace(/([?&](?:key|api_key|token)=)[^&\s]+/giu, '$1[REDACTED]').replace(/AIza[0-9A-Za-z_-]{20,}/gu, '[REDACTED_API_KEY]');
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined;
}

/** `x-ratelimit-reset` is a Unix timestamp in milliseconds (OpenRouter) or seconds; returns seconds from now. */
export function parseRateLimitReset(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return undefined;
  const epochMs = number > 1e12 ? number : number > 1e9 ? number * 1000 : undefined;
  return epochMs === undefined ? undefined : Math.max(1, Math.ceil((epochMs - now) / 1000));
}

/** POST JSON and map every failure to a typed LlmError. Never logs or returns credentials. */
export async function postJson(fetcher: FetchLike, url: string, apiKey: string, body: unknown, timeoutMs: number, provider: string, headers: Record<string, string> = {}): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const name = (error as { name?: string })?.name;
    if (name === 'TimeoutError' || name === 'AbortError') throw new LlmError('timeout', `${provider} request timed out`, { provider });
    throw new LlmError('network', `${provider} request failed: ${redact(error instanceof Error ? error.message : String(error))}`, { provider });
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    let providerMessage = text.slice(0, 400);
    try { const parsed = JSON.parse(text) as { error?: { message?: unknown } | string; message?: unknown }; const err = parsed.error; providerMessage = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : typeof parsed.message === 'string' ? parsed.message : providerMessage; } catch { /* keep raw text */ }
    providerMessage = redact(providerMessage);
    const status = response.status;
    const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after')) ?? (status === 429 ? parseRateLimitReset(response.headers.get('x-ratelimit-reset')) : undefined);
    const kind = status === 401 ? 'unauthorized' : status === 403 ? 'forbidden' : status === 429 ? 'rate_limit' : status === 408 ? 'timeout' : status >= 500 ? 'unavailable' : 'bad_request';
    throw new LlmError(kind, `${provider} HTTP ${status}: ${providerMessage}`, { provider, status, providerMessage, ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) });
  }
  try { return await response.json(); }
  catch { throw new LlmError('invalid_response', `${provider} returned invalid JSON`, { provider }); }
}
