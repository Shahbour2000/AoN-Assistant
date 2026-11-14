import { z } from 'zod';

export const AON_API_BASE_URL = 'https://app.ageofnations.world/api/v1';
const playerSchema = z.object({ id: z.string().min(1).max(80).regex(/^[A-Za-z0-9_-]+$/u), username: z.string().min(1).max(40) }).passthrough();
const numericValue = z.union([z.string(), z.number()]).optional();
const statsSchema = z.object({
  id: z.string().min(1), username: z.string().min(1), serverTime: z.string().optional(),
  level: z.number().optional(), xp: z.number().optional(), prestige: z.number().optional(), countryId: z.string().optional(), joinedAt: z.string().optional(),
  rank: z.object({ code: z.string().optional(), minDamage: z.number().optional(), next: z.object({ code: z.string().optional(), minDamage: z.number().optional() }).passthrough().optional() }).passthrough().optional(),
  damage: z.object({ all: numericValue, total: numericValue, day: numericValue, week: numericValue, month: numericValue }).passthrough().optional(),
  work: z.object({ all: numericValue, day: numericValue, week: numericValue, month: numericValue }).passthrough().optional(),
  trade: z.object({ all: numericValue, day: numericValue, week: numericValue, month: numericValue }).passthrough().optional(),
  companies: z.object({ count: z.number().optional(), investedMoney: numericValue, investedSteel: numericValue }).passthrough().optional(),
}).passthrough();
const companiesSchema = z.object({ total: z.number().optional(), limit: z.number().optional(), offset: z.number().optional(), companies: z.array(z.object({
  id: z.string().optional(), name: z.string().optional(), itemCode: z.string().optional(), countryId: z.string().optional(), regionId: z.string().optional(),
  investedMoney: numericValue, investedSteel: numericValue, workers: z.number().optional(), level: z.number().optional(), points: numericValue, maxWorkers: z.number().optional(), owner: z.unknown().optional(),
}).passthrough()) }).passthrough();
const openApiDataSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.record(z.string(), z.unknown()))]);
export type AonEntityData = z.infer<typeof openApiDataSchema>;

export type AonPlayer = z.infer<typeof playerSchema>;
export type AonStats = z.infer<typeof statsSchema>;
export type AonCompanyList = z.infer<typeof companiesSchema>;
export interface PlayerSnapshot { profile: AonPlayer; stats: AonStats; companies: AonCompanyList; fetchedAt: string; }
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export class AonApiError extends Error {
  constructor(readonly kind: 'not_found' | 'unauthorized' | 'forbidden' | 'rate_limit' | 'unavailable' | 'invalid_response' | 'request_failed', message: string, readonly status?: number, readonly retryAfterSeconds?: number) {
    super(message); this.name = 'AonApiError';
  }
}

export class AonApiClient {
  private readonly cache = new Map<string, { expiresAt: number; value: unknown }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly requestTimes: number[] = [];
  constructor(private readonly fetcher: FetchLike = fetch, private readonly baseUrl = AON_API_BASE_URL, private readonly timeoutMs = 10_000, private readonly cacheTtlMs = 30_000, private readonly now: () => number = Date.now, private readonly pause: (ms: number) => Promise<void> = delay) {}

  findPlayer(username: string): Promise<AonPlayer> {
    const value = username.trim();
    if (!value || value.length > 40) throw new Error('Player username must be 1–40 characters');
    return this.get(`/players/by-name/${encodeURIComponent(value)}`, playerSchema);
  }
  getPlayer(playerId: string): Promise<AonPlayer> { return this.get(`/players/${validateId(playerId)}`, playerSchema); }
  getStats(playerId: string): Promise<AonStats> { return this.get(`/players/${validateId(playerId)}/stats`, statsSchema); }
  getCompanies(playerId: string): Promise<AonCompanyList> { return this.get(`/players/${validateId(playerId)}/companies?limit=50&sort=invested`, companiesSchema); }
  /** Read-only generic GET used by the agent tools. Only known read endpoints are allowed; caching, dedupe, rate limits and timeouts still apply. */
  getJson(path: string): Promise<AonEntityData> {
    if (!/^\/(players|countries|companies|market|rankings|wars|battles|search|game|regions|units|parties|alliances)(\/|\?|$)/u.test(path) || path.includes('..') || path.length > 300) throw new Error('Unsupported API path');
    return this.get(path, openApiDataSchema);
  }
  searchEntities(query: string): Promise<AonEntityData> { const q = query.trim(); if (q.length < 2 || q.length > 60) throw new Error('Search query must be 2–60 characters'); return this.get(`/search?q=${encodeURIComponent(q)}`, openApiDataSchema); }
  getCountrySummary(countryId: string): Promise<AonEntityData> { return this.get(`/countries/${validateId(countryId)}/summary`, openApiDataSchema); }
  getCountryCitizens(countryId: string): Promise<AonEntityData> { return this.get(`/countries/${validateId(countryId)}/citizens`, openApiDataSchema); }
  getCountryGovernment(countryId: string): Promise<AonEntityData> { return this.get(`/countries/${validateId(countryId)}/government/members`, openApiDataSchema); }
  getCompany(companyId: string): Promise<AonEntityData> { return this.get(`/companies/${validateId(companyId)}`, openApiDataSchema); }
  getCompanyStats(countryId?: string): Promise<AonEntityData> { return this.get(`/companies/stats${countryId ? `?countryId=${encodeURIComponent(validateId(countryId))}` : ''}`, openApiDataSchema); }
  getMarket(market?: string): Promise<AonEntityData> { return this.get(`/market${market ? `?market=${encodeURIComponent(validateId(market))}` : ''}`, openApiDataSchema); }
  getMarketOrders(itemCode: string, market?: string): Promise<AonEntityData> { return this.get(`/market/${validateId(itemCode)}/orders${market ? `?market=${encodeURIComponent(validateId(market))}` : ''}`, openApiDataSchema); }
  getMarketHistory(itemCode: string, hours = 168, market?: string): Promise<AonEntityData> { if (!Number.isInteger(hours) || hours < 1 || hours > 720) throw new Error('Market history hours must be 1–720'); return this.get(`/market/${validateId(itemCode)}/history?hours=${hours}${market ? `&market=${encodeURIComponent(validateId(market))}` : ''}`, openApiDataSchema); }
  getBattles(status: 'active' | 'finished' = 'active', countryId?: string): Promise<AonEntityData> { return this.get(`/battles?status=${status}${countryId ? `&countryId=${encodeURIComponent(validateId(countryId))}` : ''}`, openApiDataSchema); }
  getWars(status: 'active' | 'ended' = 'active', countryId?: string): Promise<AonEntityData> { return this.get(`/wars?status=${status}${countryId ? `&countryId=${encodeURIComponent(validateId(countryId))}` : ''}`, openApiDataSchema); }

  refreshPlayer(playerId: string, username?: string): Promise<PlayerSnapshot> {
    const id = validateId(playerId);
    for (const key of [`/players/${id}`, `/players/${id}/stats`, `/players/${id}/companies?limit=50&sort=invested`]) this.cache.delete(key);
    if (username) this.cache.delete(`/players/by-name/${encodeURIComponent(username.trim())}`);
    return this.getSnapshot(playerId);
  }

  async getSnapshot(playerId: string): Promise<PlayerSnapshot> {
    const [profile, stats, companies] = await Promise.all([this.getPlayer(playerId), this.getStats(playerId), this.getCompanies(playerId)]);
    return { profile, stats, companies, fetchedAt: new Date(this.now()).toISOString() };
  }

  private async get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    const cacheKey = path;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > this.now()) return cached.value as T;
    const pending = this.inFlight.get(cacheKey);
    if (pending) return pending as Promise<T>;
    const request = this.request(path, schema).then((value) => {
      this.cache.set(cacheKey, { expiresAt: this.now() + this.cacheTtlMs, value });
      return value;
    }).finally(() => this.inFlight.delete(cacheKey));
    this.inFlight.set(cacheKey, request);
    return request;
  }

  private async request<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      await this.waitForRateSlot();
      let response: Response;
      try { response = await this.fetcher(`${this.baseUrl}${path}`, { signal: AbortSignal.timeout(this.timeoutMs), headers: { Accept: 'application/json' } }); }
      catch (error) {
        if (attempt === 0) { await this.pause(400); continue; }
        throw new AonApiError('unavailable', error instanceof Error ? error.message : 'API request failed');
      }
      if (response.status === 429) {
        const retryAfter = parseRetryAfter(response.headers.get('retry-after'), this.now());
        if (attempt === 0 && retryAfter !== undefined && retryAfter <= 30) { await this.pause(retryAfter * 1000); continue; }
        throw new AonApiError('rate_limit', 'Age of Nations API rate limit reached', 429, retryAfter);
      }
      if (!response.ok) {
        const kind = response.status === 404 ? 'not_found' : response.status === 401 ? 'unauthorized' : response.status === 403 ? 'forbidden' : response.status >= 500 ? 'unavailable' : 'request_failed';
        throw new AonApiError(kind, `Age of Nations API returned HTTP ${response.status}`, response.status);
      }
      let payload: unknown;
      try { payload = await response.json(); }
      catch { throw new AonApiError('invalid_response', 'Age of Nations API returned invalid JSON', response.status); }
      const parsed = schema.safeParse(payload);
      if (!parsed.success) throw new AonApiError('invalid_response', 'Age of Nations API response did not match expected public fields', response.status);
      return parsed.data;
    }
    throw new AonApiError('unavailable', 'Age of Nations API request did not complete');
  }

  private async waitForRateSlot(): Promise<void> {
    const startedAt = this.now();
    while (true) {
      const now = this.now();
      while (this.requestTimes.length && this.requestTimes[0]! <= now - 60_000) this.requestTimes.shift();
      if (this.requestTimes.length < 55) { this.requestTimes.push(now); return; }
      const waitMs = Math.max(1, this.requestTimes[0]! + 60_000 - now);
      if (now - startedAt + waitMs > 30_000) throw new AonApiError('rate_limit', 'Local Age of Nations API request limit reached', 429, Math.ceil(waitMs / 1000));
      await this.pause(waitMs);
    }
  }
}

function validateId(id: string): string {
  if (!/^[A-Za-z0-9_-]{1,80}$/u.test(id)) throw new Error('Invalid Age of Nations player ID');
  return encodeURIComponent(id);
}
function parseRetryAfter(value: string | null, now: number): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now) / 1000)) : undefined;
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
