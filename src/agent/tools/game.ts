import { addGold, compact, MONEY_NOTE, toGold } from '../compact.js';
import { InvalidInput, int, oneOf, str, type ActivePlayer, type AgentTool, type GameApi, type ToolContext, type ToolResult } from './types.js';

type ApiOutcome = { ok: true; data: unknown } | { ok: false; result: ToolResult };

/**
 * Call the read-only game API and translate every failure into a precise, model-readable status. The distinction
 * matters: `not_found` (HTTP 404) is the only outcome that means "this entity does not exist". Everything else is
 * temporary or an upstream problem and must never be reported to a player as "no such player".
 */
async function call(ctx: ToolContext, path: string): Promise<ApiOutcome> {
  if (!ctx.api) return { ok: false, result: { status: 'unavailable', kind: 'api_not_configured', note: 'Live game data is not available in this deployment.' } };
  try { return { ok: true, data: await ctx.api.getJson(path) }; }
  catch (error) { return { ok: false, result: apiFailure(error, path) }; }
}

export function apiFailure(error: unknown, endpoint: string): ToolResult {
  const kind = (error as { kind?: string } | undefined)?.kind;
  const base = { endpoint, fetchedAt: new Date().toISOString() };
  if (kind === 'not_found') return { status: 'not_found', ...base, note: 'The game API answered 404 for this exact id/name: it does not exist (check spelling, or search first).' };
  if (kind === 'rate_limit') return { status: 'rate_limited', ...base, note: 'The game API is rate limiting requests right now. This is temporary and says NOTHING about whether the data exists. Tell the player it is temporarily unavailable and to retry shortly.' };
  if (kind === 'invalid_response') return { status: 'unavailable', kind, ...base, note: 'The game API returned a malformed or unexpected response. Do not guess any values; say the data could not be read right now.' };
  return { status: 'unavailable', kind: kind ?? 'request_failed', ...base, note: 'Temporary failure reaching the game API (timeout/network/server error). This is NOT evidence that the player, country or data does not exist, and you must not invent any values. Tell the player the live data is temporarily unavailable.' };
}

const source = (endpoint: string) => ({ endpoint, fetchedAt: new Date().toISOString() });
const isPlayerId = (value: string) => /^usr_[A-Za-z0-9]{6,40}$/u.test(value);
const safeId = (value: string) => /^[A-Za-z0-9_-]{1,80}$/u.test(value);

// ---------------------------------------------------------------- players

const PLAYER_MONEY = new Set(['wagesEarned', 'value', 'investedMoney']);

function pickPlayer(raw: Record<string, unknown>): Record<string, unknown> {
  const skills = Array.isArray(raw.skills) ? Object.fromEntries((raw.skills as Array<{ code?: string; level?: number; maxLevel?: number }>).filter((s) => s.code).map((s) => [s.code, `${s.level ?? 0}/${s.maxLevel ?? '?'}`])) : undefined;
  const economy = raw.economy as { lifetime?: unknown; recent?: unknown; companies?: unknown; presence?: unknown } | undefined;
  return addGold({
    id: raw.id, username: raw.username, level: raw.level, xp: raw.xp, xpNextLevel: raw.xpNextLevel, prestige: raw.prestige,
    rank: raw.rank, countryId: raw.countryId, homeRegionId: raw.homeRegionId, joinedAt: raw.joinedAt, bio: raw.bio, premium: raw.premium,
    damage: raw.damage, skills, party: raw.party, militaryUnit: raw.unit, offices: (raw.roles as { offices?: unknown } | undefined)?.offices,
    economy: economy && { companies: economy.companies, presence: economy.presence, lifetime: economy.lifetime, last30Days: economy.recent },
  }, PLAYER_MONEY) as Record<string, unknown>;
}

async function lookupByName(ctx: ToolContext, username: string): Promise<{ ok: true; raw: Record<string, unknown> } | { ok: false; result: ToolResult }> {
  const endpoint = `/players/by-name/${encodeURIComponent(username)}`;
  const outcome = await call(ctx, endpoint);
  if (!outcome.ok) {
    if (outcome.result.status === 'not_found') {
      // Offer real candidates from the API's own search so the player can pick the right spelling. Failure here is non-fatal.
      const search = await call(ctx, `/search?q=${encodeURIComponent(username)}`);
      const players = search.ok ? ((search.data as { players?: Array<Record<string, unknown>> })?.players ?? []).slice(0, 6).map((p) => ({ id: p.id, username: p.username, countryId: p.countryId, level: p.level })) : undefined;
      return { ok: false, result: { ...outcome.result, username, ...(players?.length ? { similarPlayers: players, note: `${String(outcome.result.note)} Similar real players are listed in similarPlayers — suggest them, do not assume one is the right person.` } : {}) } };
    }
    return { ok: false, result: { ...outcome.result, username } };
  }
  const raw = outcome.data as Record<string, unknown>;
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.username !== 'string' || !safeId(raw.id)) return { ok: false, result: { status: 'unavailable', kind: 'invalid_response', username, note: 'The game API returned a malformed player record. Do not guess any values.' } };
  return { ok: true, raw };
}

async function resolvePlayer(ctx: ToolContext, reference: string | undefined): Promise<{ ok: true; player: ActivePlayer; raw?: Record<string, unknown> } | { ok: false; result: ToolResult }> {
  if (!reference) {
    const active = ctx.getActivePlayer();
    if (!active) return { ok: false, result: { status: 'needs_input', note: 'No player has been discussed in this conversation yet. Ask the player for the exact in-game username.' } };
    return { ok: true, player: active };
  }
  if (isPlayerId(reference)) return { ok: true, player: { id: reference, username: ctx.getActivePlayer()?.id === reference ? ctx.getActivePlayer()!.username : reference, fetchedAt: new Date().toISOString() } };
  const found = await lookupByName(ctx, reference);
  if (!found.ok) return found;
  const player = { id: String(found.raw.id), username: String(found.raw.username), fetchedAt: new Date().toISOString() };
  ctx.setActivePlayer(player);
  return { ok: true, player, raw: found.raw };
}

export const findPlayer: AgentTool = {
  name: 'find_player',
  kind: 'game',
  description: 'Look up ONE player by exact in-game username and return their live public profile (id, level, rank, country, damage totals, skills, economy summary). Use when the player names a specific user or asks about "my profile" after giving their username. The found player becomes the "active player" for follow-ups ("his damage?"). Never use for country names — countries are not players. Never guess usernames.',
  parameters: { type: 'object', properties: { username: { type: 'string', description: 'Exact in-game username as the player wrote it.' } }, required: ['username'], additionalProperties: false },
  async execute(args, ctx) {
    const username = str(args, 'username', { max: 40 })!;
    const found = await lookupByName(ctx, username);
    if (!found.ok) return found.result;
    const player = { id: String(found.raw.id), username: String(found.raw.username), fetchedAt: new Date().toISOString() };
    ctx.setActivePlayer(player);
    return { status: 'ok', source: source(`/players/by-name/${username}`), note: `${MONEY_NOTE} "damage.total" is lifetime damage points. This is public data; account ownership is not verified.`, player: compact(pickPlayer(found.raw), 5000) };
  },
};

export const getPlayerData: AgentTool = {
  name: 'get_player_data',
  kind: 'game',
  description: 'Fetch live numbers for a player: "stats" (lifetime and 30/7/1-day damage, work, trade, company totals), "profile" (level, rank, skills, economy) and/or "companies" (the player\'s companies). Omit "player" to use the active player from the conversation (follow-ups like "and his companies?"). Pass a username or a player id (usr_…) to switch players.',
  parameters: { type: 'object', properties: { player: { type: 'string', description: 'Username or player id. Omit for the active player.' }, include: { type: 'array', items: { type: 'string', enum: ['stats', 'profile', 'companies'] }, minItems: 1, maxItems: 3, description: 'Which data to fetch (default ["stats"]).' } }, additionalProperties: false },
  async execute(args, ctx) {
    const reference = str(args, 'player', { optional: true, max: 80 });
    const includeRaw = Array.isArray(args.include) ? args.include : ['stats'];
    const include = [...new Set(includeRaw.filter((item): item is 'stats' | 'profile' | 'companies' => item === 'stats' || item === 'profile' || item === 'companies'))];
    if (!include.length) throw new InvalidInput('"include" must contain stats, profile and/or companies');
    const resolved = await resolvePlayer(ctx, reference);
    if (!resolved.ok) return resolved.result;
    const { player } = resolved;
    const data: Record<string, unknown> = {};
    const failures: Record<string, ToolResult> = {};
    const endpoints: string[] = [];
    await Promise.all(include.map(async (part) => {
      if (part === 'profile' && resolved.raw) { data.profile = pickPlayer(resolved.raw); endpoints.push(`/players/by-name/${player.username}`); return; }
      const endpoint = part === 'stats' ? `/players/${player.id}/stats` : part === 'profile' ? `/players/${player.id}` : `/players/${player.id}/companies?limit=15&sort=invested`;
      endpoints.push(endpoint);
      const outcome = await call(ctx, endpoint);
      if (!outcome.ok) { failures[part] = outcome.result; return; }
      const raw = outcome.data as Record<string, unknown>;
      data[part] = part === 'profile' ? pickPlayer(raw) : part === 'companies' ? addGold(raw, PLAYER_MONEY) : addGold(raw, PLAYER_MONEY);
    }));
    const failedParts = Object.keys(failures);
    if (failedParts.length === include.length) {
      // Surface the most specific failure (a 404 for an unknown id beats a generic outage).
      const first = (failures[failedParts[0]!] ?? { status: 'unavailable' }) as ToolResult;
      return { ...first, player: player.username };
    }
    return {
      status: failedParts.length ? 'partial' : 'ok', player: { id: player.id, username: player.username }, source: { endpoints, fetchedAt: new Date().toISOString() },
      note: `${MONEY_NOTE} stats.damage.all / profile.damage.total is lifetime damage points; work and trade are counts/values as reported by the API.`,
      data: compact(data, 6000), ...(failedParts.length ? { unavailable: failures } : {}),
    };
  },
};

// ---------------------------------------------------------------- search & countries

export const searchGame: AgentTool = {
  name: 'search_game',
  kind: 'game',
  description: 'Search the live game for players, countries, regions, military units, parties, alliances and articles by name. Use it to resolve a name to an id and to tell what kind of thing a name is (a country such as "Egypt" is NOT a player named Egypt). The result groups matches by type — read the type before assuming anything.',
  parameters: { type: 'object', properties: { query: { type: 'string', description: 'Name or partial name.' } }, required: ['query'], additionalProperties: false },
  async execute(args, ctx) {
    const query = str(args, 'query', { max: 60 })!;
    if (query.length < 2) throw new InvalidInput('"query" must have at least 2 characters');
    const endpoint = `/search?q=${encodeURIComponent(query)}`;
    const outcome = await call(ctx, endpoint);
    if (!outcome.ok) return outcome.result;
    const raw = outcome.data as Record<string, unknown>;
    const groups = Object.fromEntries(['players', 'countries', 'regions', 'units', 'parties', 'alliances', 'articles'].map((key) => [key, Array.isArray(raw?.[key]) ? (raw[key] as unknown[]).slice(0, 6) : []]).filter(([, list]) => (list as unknown[]).length));
    if (!Object.keys(groups).length) return { status: 'no_results', query, source: source(endpoint), note: 'The game search found nothing with this name.' };
    return { status: 'ok', query, source: source(endpoint), results: compact(groups, 4000) };
  },
};

function summarizeCountry(raw: Record<string, unknown>): Record<string, unknown> {
  const gov = raw.government as { holders?: unknown } | undefined;
  const core = Array.isArray(raw.coreRegions) ? raw.coreRegions as Array<{ controlledBy?: string }> : undefined;
  return addGold({
    id: raw.id, name: raw.name, specializedItem: raw.specializedItem, citizens: raw.citizens, development: raw.development, worldSharePercent: raw.worldSharePercent,
    taxes: raw.taxes, treasury: raw.treasury, citizenshipFee: raw.citizenshipFee, capitalRegionId: raw.capitalRegionId, capitalHeld: raw.capitalHeld,
    coreRegionCount: core?.length, coreRegionsHeld: core?.filter((r) => r.controlledBy === raw.id).length,
    controlledRegionCount: Array.isArray(raw.controlledRegions) ? raw.controlledRegions.length : undefined,
    government: gov?.holders, rulingParty: raw.rulingParty && { id: (raw.rulingParty as { id?: unknown }).id, name: (raw.rulingParty as { name?: unknown }).name },
    wars: raw.wars, alliance: raw.alliance, protectorate: raw.protectorate, enemy: raw.enemy, unrest: raw.unrest, rankings: raw.rankings,
  }, new Set(['citizenshipFee', 'revenueToday', 'money'])) as Record<string, unknown>;
}

const COUNTRY_SECTIONS = ['overview', 'summary', 'citizens', 'government', 'wars', 'battles', 'companies', 'units', 'parties', 'elections', 'laws'] as const;
const SECTION_PATH: Record<(typeof COUNTRY_SECTIONS)[number], string> = { overview: '', summary: '/summary', citizens: '/citizens', government: '/government/members', wars: '/wars', battles: '/battles', companies: '/companies/stats', units: '/units', parties: '/parties', elections: '/elections', laws: '/laws' };

async function resolveCountry(ctx: ToolContext, reference: string): Promise<{ ok: true; id: string } | { ok: false; result: ToolResult }> {
  if (/^[A-Za-z]{2,3}$/u.test(reference)) {
    const direct = await call(ctx, `/countries/${reference.toLowerCase()}`);
    if (direct.ok) return { ok: true, id: reference.toLowerCase() };
    if (direct.result.status !== 'not_found') return { ok: false, result: direct.result };
  }
  const search = await call(ctx, `/search?q=${encodeURIComponent(reference)}`);
  if (!search.ok) return { ok: false, result: search.result };
  const countries = ((search.data as { countries?: Array<{ id?: string; name?: string }> })?.countries ?? []).filter((c) => typeof c.id === 'string' && safeId(c.id));
  const exact = countries.filter((c) => c.name?.toLowerCase() === reference.toLowerCase() || c.id?.toLowerCase() === reference.toLowerCase());
  const pick = exact.length === 1 ? exact[0] : countries.length === 1 ? countries[0] : undefined;
  if (pick?.id) return { ok: true, id: pick.id };
  if (countries.length > 1) return { ok: false, result: { status: 'needs_input', note: 'Several countries match. Ask the player which one they mean.', candidates: countries.slice(0, 6) } };
  return { ok: false, result: { status: 'not_found', note: `No country named "${reference}" was found in the game (search covered countries, players, regions and more; a player or region with that name is not a country).` } };
}

export const getCountry: AgentTool = {
  name: 'get_country',
  kind: 'game',
  description: 'Live information about one country: "overview" (citizens total/active — i.e. population, development, taxes, treasury, specialized item, government holders, wars, alliance), plus sections "citizens", "government" (current office holders), "wars", "battles", "companies" (production totals), "units", "parties", "elections", "laws", or "summary" (government, wars, battles, laws, elections together). Accepts a country id (e.g. "eg") or an English name (e.g. "Egypt").',
  parameters: { type: 'object', properties: { country: { type: 'string', description: 'Country id (e.g. "eg") or name (e.g. "Egypt").' }, section: { type: 'string', enum: [...COUNTRY_SECTIONS], description: 'Default "overview".' } }, required: ['country'], additionalProperties: false },
  async execute(args, ctx) {
    const reference = str(args, 'country', { max: 60 })!;
    const section = oneOf(args, 'section', COUNTRY_SECTIONS, 'overview');
    const country = await resolveCountry(ctx, reference);
    if (!country.ok) return country.result;
    const endpoint = `/countries/${country.id}${SECTION_PATH[section]}`;
    const outcome = await call(ctx, endpoint);
    if (!outcome.ok) return { ...outcome.result, country: country.id };
    const data = section === 'overview' ? summarizeCountry(outcome.data as Record<string, unknown>) : addGold(outcome.data, new Set(['money', 'revenueToday', 'citizenshipFee']));
    return { status: 'ok', country: country.id, section, source: source(endpoint), note: `${MONEY_NOTE} "citizens.total" is all citizens; "citizens.active" played recently.`, data: compact(data, 6000) };
  },
};

// ---------------------------------------------------------------- rankings, market, wars, companies, rules

const BOARDS = ['playerDamage', 'playerLevel', 'playerWork', 'playerTrade', 'playerWealth', 'muDamage', 'muTreasury', 'muMembers', 'countryDamage', 'countryDevelopment', 'countryPopulation', 'countryRegions', 'countryTreasury', 'allianceDevelopment', 'allianceDamage', 'allianceMembers'] as const;
const WEALTH_BOARDS = new Set(['playerWealth', 'muTreasury', 'countryTreasury']);

export const getRankings: AgentTool = {
  name: 'get_rankings',
  kind: 'game',
  description: 'Leaderboards: top players by damage/level/work/trade/wealth, military units, countries (damage, development, active population, regions, treasury) or alliances. Optionally scoped to a country id (player and unit boards) and a period (all, monthly, weekly, daily, or current for live boards).',
  parameters: { type: 'object', properties: { board: { type: 'string', enum: [...BOARDS] }, period: { type: 'string', enum: ['all', 'monthly', 'weekly', 'daily', 'current'], description: 'Default: "all" for damage/work/trade boards, otherwise "current".' }, countryId: { type: 'string', description: 'Optional country id such as "eg".' }, limit: { type: 'integer', minimum: 1, maximum: 25, description: 'Default 10.' } }, required: ['board'], additionalProperties: false },
  async execute(args, ctx) {
    const board = oneOf(args, 'board', BOARDS);
    const defaultPeriod = /Damage$|Work$|Trade$/u.test(board) ? 'all' : 'current';
    const period = oneOf(args, 'period', ['all', 'monthly', 'weekly', 'daily', 'current'] as const, defaultPeriod);
    const countryId = str(args, 'countryId', { optional: true, max: 20 });
    if (countryId && !safeId(countryId)) throw new InvalidInput('"countryId" is not a valid id');
    const limit = int(args, 'limit', 1, 25, 10);
    const endpoint = `/rankings/${board}?period=${period}&limit=${limit}${countryId ? `&countryId=${encodeURIComponent(countryId)}` : ''}`;
    const outcome = await call(ctx, endpoint);
    if (!outcome.ok) return outcome.result;
    const raw = outcome.data as { board?: { label?: string; grain?: string }; rows?: Array<Record<string, unknown>>; period?: string };
    const rows = (raw.rows ?? []).map((row) => ({ rank: row.rank, name: row.name, subjectId: row.subjectId, countryId: row.countryId, value: row.value, ...(WEALTH_BOARDS.has(board) ? { valueGold: toGold(row.value) } : {}), extra: row.extra }));
    if (!rows.length) return { status: 'no_results', board, period, source: source(endpoint), note: 'The leaderboard returned no rows.' };
    return { status: 'ok', board, label: raw.board?.label, measures: raw.board?.grain, period: raw.period ?? period, source: source(endpoint), rows: compact(rows, 4500), note: WEALTH_BOARDS.has(board) ? MONEY_NOTE : 'Damage values are damage points.' };
  },
};

export const getMarket: AgentTool = {
  name: 'get_market',
  kind: 'game',
  description: 'Live market data: "prices" (best ask/bid and last price for every item), "orders" (order book of one item), "history" (price history of one item, in hours) or "trades" (recent trades of one item). Prices are in gold already converted; never infer profitability from a single price.',
  parameters: { type: 'object', properties: { view: { type: 'string', enum: ['prices', 'orders', 'history', 'trades'] }, itemCode: { type: 'string', description: 'Item code such as "steel" (required except for "prices").' }, hours: { type: 'integer', minimum: 1, maximum: 720 }, market: { type: 'string', description: 'Country id for a local market; omit for the global (gold) market.' } }, required: ['view'], additionalProperties: false },
  async execute(args, ctx) {
    const view = oneOf(args, 'view', ['prices', 'orders', 'history', 'trades'] as const);
    const itemCode = str(args, 'itemCode', { optional: true, max: 60 });
    if (view !== 'prices' && !itemCode) return { status: 'needs_input', note: 'Which item? Provide itemCode (for example "steel" or "concrete"). Use view "prices" first to see all item codes.' };
    if (itemCode && !safeId(itemCode)) throw new InvalidInput('"itemCode" is not a valid code');
    const market = str(args, 'market', { optional: true, max: 20 });
    if (market && !safeId(market)) throw new InvalidInput('"market" is not a valid id');
    const query = new URLSearchParams();
    if (view === 'history') query.set('hours', String(int(args, 'hours', 1, 720, 168)));
    if (market) query.set('market', market);
    const endpoint = view === 'prices' ? `/market${market ? `?market=${market}` : ''}` : `/market/${itemCode}/${view}${query.size ? `?${query}` : ''}`;
    const outcome = await call(ctx, endpoint);
    if (!outcome.ok) return outcome.result;
    const money = new Set(['bestAsk', 'bestBid', 'last', 'price', 'open', 'high', 'low', 'close', 'avg', 'pricePerUnit']);
    return { status: 'ok', view, itemCode, source: source(endpoint), note: `${MONEY_NOTE} bestAsk is the cheapest sell offer, bestBid the highest buy offer; null means no offers.`, data: compact(addGold(outcome.data, money), 5000) };
  },
};

export const getWarsAndBattles: AgentTool = {
  name: 'get_wars_battles',
  kind: 'game',
  description: 'Live wars between countries or battles, filtered by status (active/ended for wars, active/finished for battles) and optionally by country id.',
  parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['wars', 'battles'] }, status: { type: 'string', enum: ['active', 'ended', 'finished'] }, countryId: { type: 'string' } }, required: ['kind'], additionalProperties: false },
  async execute(args, ctx) {
    const kind = oneOf(args, 'kind', ['wars', 'battles'] as const);
    const status = oneOf(args, 'status', kind === 'wars' ? ['active', 'ended'] as const : ['active', 'finished'] as const, 'active');
    const countryId = str(args, 'countryId', { optional: true, max: 20 });
    if (countryId && !safeId(countryId)) throw new InvalidInput('"countryId" is not a valid id');
    const endpoint = `/${kind}?status=${status}${countryId ? `&countryId=${encodeURIComponent(countryId)}` : ''}`;
    const outcome = await call(ctx, endpoint);
    if (!outcome.ok) return outcome.result;
    return { status: 'ok', kind, filter: status, source: source(endpoint), data: compact(outcome.data, 5000) };
  },
};

export const getCompany: AgentTool = {
  name: 'get_company',
  kind: 'game',
  description: 'Live details of one company by company id (cmp_…), or — with no id — the richest companies in a country/globally. For a player\'s own companies use get_player_data with include ["companies"].',
  parameters: { type: 'object', properties: { companyId: { type: 'string' }, countryId: { type: 'string', description: 'When no companyId: list the richest companies of this country.' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, additionalProperties: false },
  async execute(args, ctx) {
    const companyId = str(args, 'companyId', { optional: true, max: 80 });
    const countryId = str(args, 'countryId', { optional: true, max: 20 });
    if ((companyId && !safeId(companyId)) || (countryId && !safeId(countryId))) throw new InvalidInput('id is not valid');
    const limit = int(args, 'limit', 1, 20, 10);
    const endpoint = companyId ? `/companies/${companyId}` : countryId ? `/countries/${countryId}/companies?limit=${limit}` : `/companies?limit=${limit}`;
    const outcome = await call(ctx, endpoint);
    if (!outcome.ok) return outcome.result;
    return { status: 'ok', source: source(endpoint), note: MONEY_NOTE, data: compact(addGold(outcome.data, new Set(['investedMoney'])), 5000) };
  },
};

export const getGameRules: AgentTool = {
  name: 'get_game_rules',
  kind: 'game',
  description: 'The live ruleset constants served by the game API: battle rules (rounds to win, points, health cost, cooldown, loot) and mercenary-contract rules. Use for exact battle/contract numbers; prefer the wiki (search_knowledge) for explanations.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  async execute(_args, ctx) {
    const outcome = await call(ctx, '/game');
    if (!outcome.ok) return outcome.result;
    const raw = outcome.data as Record<string, unknown>;
    return { status: 'ok', source: source('/game'), data: compact({ rulesetVersion: raw.rulesetVersion, battleRules: raw.battleRules, contractRules: raw.contractRules }, 3500) };
  },
};

export const GAME_TOOLS: AgentTool[] = [findPlayer, getPlayerData, searchGame, getCountry, getRankings, getMarket, getWarsAndBattles, getCompany, getGameRules];
