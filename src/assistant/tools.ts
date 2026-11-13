import { z } from 'zod';
import type { AonApiClient } from '../aon-api/client.js';
import { AonApiError } from '../aon-api/client.js';
import type { KnowledgeChunk } from '../knowledge/retrieval.js';
import type { LocalAgentTool } from '../groq/client.js';
import { buildPlayerContext } from '../aon-api/analysis.js';
import type { PlayerSnapshot } from '../aon-api/client.js';

export interface PlayerSelection { id: string; username: string; fetchedAt: string; }
const queryArgs = z.object({ query: z.string().min(2).max(300) }).strict();
const usernameArgs = z.object({ username: z.string().min(1).max(40) }).strict();
const dataArgs = z.object({ fields: z.array(z.enum(['profile', 'stats', 'companies'])).min(1).max(3).optional() }).strict();

export function createAgentTools(options: { chunks: KnowledgeChunk[]; api?: AonApiClient; selected: PlayerSelection | undefined; setSelected: (player: PlayerSelection) => void; setWaitingForUsername?: () => void; onPlayerSnapshot?: (playerId: string, snapshot: PlayerSnapshot) => unknown; apiReference?: string }): LocalAgentTool[] {
  let selected = options.selected;
  const tools: LocalAgentTool[] = [
    { name: 'search_knowledge', description: 'Search trusted Age of Nations wiki and API reference for game rules or documented capabilities. Call for game-mechanics questions, not casual chat.', parameters: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 300 } }, required: ['query'], additionalProperties: false }, execute: async (raw) => {
      const { query } = queryArgs.parse(raw);
      const results = bm25Search(options.chunks, query, 5);
      const apiTerms = new Set(tokenize(query));
      const refHit = options.apiReference && [...apiTerms].some((t) => options.apiReference!.toLocaleLowerCase().includes(t));
      return { status: results.length > 0 || Boolean(refHit) ? 'success' : 'insufficient', source: 'knowledge', results, apiReferenceExcerpt: refHit ? options.apiReference!.slice(0, 2500) : undefined, sufficient: results.length > 0 || Boolean(refHit), fetchedAt: new Date().toISOString() };
    } },
  ];
  tools.push({ name: 'request_player_username', description: 'Use when the user asks whether a player can be looked up or asks for their player data without providing a username. This records that the next bare username is expected.', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false }, execute: async () => { options.setWaitingForUsername?.(); return { status: 'needs_username' }; } });
  if (options.api) {
    tools.push({ name: 'lookup_player', description: 'Find a player by an explicitly provided in-game username; fetch and select their current public snapshot for follow-ups.', parameters: { type: 'object', properties: { username: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['username'], additionalProperties: false }, execute: async (raw) => {
      const { username } = usernameArgs.parse(raw);
      try {
        const profile = await options.api!.findPlayer(username);
        const [stats, companies] = await Promise.allSettled([options.api!.getStats(profile.id), options.api!.getCompanies(profile.id)]);
        const fetchedAt = new Date().toISOString();
        const selection = { id: profile.id, username: profile.username, fetchedAt };
        selected = selection; options.setSelected(selection);
        const data = { profile, ...(stats.status === 'fulfilled' ? { stats: stats.value } : {}), ...(companies.status === 'fulfilled' ? { companies: companies.value } : {}) };
        const snapshot: PlayerSnapshot = { profile, stats: stats.status === 'fulfilled' ? stats.value : { id: profile.id, username: profile.username }, companies: companies.status === 'fulfilled' ? companies.value : { companies: [] }, fetchedAt };
        return { status: stats.status === 'fulfilled' && companies.status === 'fulfilled' ? 'success' : 'partial', source: { endpoints: ['/players/by-name/{username}', `/players/${profile.id}/stats`, `/players/${profile.id}/companies`], fetchedAt }, ...selection, data, unavailableFields: [stats.status === 'rejected' ? 'stats' : undefined, companies.status === 'rejected' ? 'companies' : undefined].filter(Boolean), analysis: stats.status === 'fulfilled' && companies.status === 'fulfilled' ? JSON.parse(buildPlayerContext(snapshot)) : undefined, onboarding: options.onPlayerSnapshot?.(profile.id, snapshot) };
      } catch (error) { if (error instanceof AonApiError) return { status: error.kind === 'not_found' ? 'not_found' : 'unavailable', username }; throw error; }
    } });
    tools.push({ name: 'get_selected_player_data', description: 'Fetch selected player live profile, stats and/or companies for a follow-up. Use after lookup_player in this conversation.', parameters: { type: 'object', properties: { fields: { type: 'array', items: { type: 'string', enum: ['profile', 'stats', 'companies'] }, minItems: 1, maxItems: 3 } }, additionalProperties: false }, execute: async (raw) => {
      const { fields = ['profile', 'stats'] } = dataArgs.parse(raw);
      if (!selected) return { status: 'needs_player', message: 'Ask the user for the in-game username first.' };
      const sourceEndpoints: string[] = [];
      const result: Record<string, unknown> = { status: 'success', player: selected.username, source: { fetchedAt: new Date().toISOString(), endpoints: sourceEndpoints }, data: {} as Record<string, unknown> };
      const data = result.data as Record<string, unknown>; const failed: string[] = [];
      for (const field of fields) {
        sourceEndpoints.push(field === 'profile' ? `/players/${selected.id}` : field === 'stats' ? `/players/${selected.id}/stats` : `/players/${selected.id}/companies`);
        try { data[field] = field === 'profile' ? await options.api!.getPlayer(selected.id) : field === 'stats' ? await options.api!.getStats(selected.id) : await options.api!.getCompanies(selected.id); } catch { failed.push(field); }
      }
      if (failed.length) { result.status = Object.keys(data).length ? 'partial' : 'unavailable'; result.unavailableFields = failed; }
      if (fields.includes('stats') && fields.includes('profile') && data.stats && data.profile) result.analysis = JSON.parse(buildPlayerContext({ profile: data.profile as import('../aon-api/client.js').AonPlayer, stats: data.stats as import('../aon-api/client.js').AonStats, companies: { companies: [] }, fetchedAt: String(result.source && (result.source as { fetchedAt: string }).fetchedAt) }, { includeCompanies: fields.includes('companies') && Boolean(data.companies) }));
      if (fields.includes('profile') && fields.includes('stats') && fields.includes('companies') && data.profile && data.stats && data.companies) result.onboarding = options.onPlayerSnapshot?.(selected.id, { profile: data.profile as import('../aon-api/client.js').AonPlayer, stats: data.stats as import('../aon-api/client.js').AonStats, companies: data.companies as import('../aon-api/client.js').AonCompanyList, fetchedAt: String((result.source as { fetchedAt: string }).fetchedAt) });
      return result;
    } });
    tools.push({ name: 'search_game_entities', description: 'Search documented public game entities such as countries, players or units by name. Use this before fetching country or company details when only a display name is known.', parameters: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 60 } }, required: ['query'], additionalProperties: false }, execute: async (raw) => { const { query } = queryArgs.parse(raw); try { return { status: 'success', source: { endpoint: '/search', fetchedAt: new Date().toISOString() }, data: await options.api!.searchEntities(query) }; } catch (error) { return apiErrorResult(error); } } });
    const idArgs = z.object({ id: z.string().min(1).max(80) }).strict();
    tools.push({ name: 'get_country_data', description: 'Fetch a country summary, citizens, or government members using a country ID returned by search_game_entities.', parameters: { type: 'object', properties: { countryId: { type: 'string', minLength: 1, maxLength: 80 }, section: { type: 'string', enum: ['summary', 'citizens', 'government'] } }, required: ['countryId', 'section'], additionalProperties: false }, execute: async (raw) => { const { countryId, section } = z.object({ countryId: idArgs.shape.id, section: z.enum(['summary', 'citizens', 'government']) }).strict().parse(raw); const endpoint = section === 'summary' ? `/countries/${countryId}/summary` : section === 'citizens' ? `/countries/${countryId}/citizens` : `/countries/${countryId}/government/members`; try { const data = section === 'summary' ? await options.api!.getCountrySummary(countryId) : section === 'citizens' ? await options.api!.getCountryCitizens(countryId) : await options.api!.getCountryGovernment(countryId); return { status: 'success', source: { endpoint, fetchedAt: new Date().toISOString() }, data }; } catch (error) { return apiErrorResult(error, endpoint); } } });
    tools.push({ name: 'get_game_activity', description: 'Retrieve current active or finished wars and battles, optionally scoped to a country ID.', parameters: { type: 'object', properties: { kind: { type: 'string', enum: ['wars', 'battles'] }, status: { type: 'string', enum: ['active', 'finished', 'ended'] }, countryId: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['kind', 'status'], additionalProperties: false }, execute: async (raw) => { const args = z.object({ kind: z.enum(['wars', 'battles']), status: z.string(), countryId: z.string().min(1).max(80).optional() }).strict().parse(raw); try { const status = args.kind === 'wars' ? z.enum(['active', 'ended']).parse(args.status) : z.enum(['active', 'finished']).parse(args.status); const data = args.kind === 'wars' ? await options.api!.getWars(status as 'active' | 'ended', args.countryId) : await options.api!.getBattles(status as 'active' | 'finished', args.countryId); return { status: 'success', source: { endpoint: `/${args.kind}`, fetchedAt: new Date().toISOString() }, data }; } catch (error) { return apiErrorResult(error); } } });
    tools.push({ name: 'get_company_data', description: 'Fetch documented company detail or aggregate company production statistics. Use search_game_entities to resolve a company name first.', parameters: { type: 'object', properties: { companyId: { type: 'string', minLength: 1, maxLength: 80 }, countryId: { type: 'string', minLength: 1, maxLength: 80 } }, additionalProperties: false }, execute: async (raw) => { const args = z.object({ companyId: z.string().min(1).max(80).optional(), countryId: z.string().min(1).max(80).optional() }).strict().parse(raw); try { const endpoint = args.companyId ? `/companies/${args.companyId}` : '/companies/stats'; const data = args.companyId ? await options.api!.getCompany(args.companyId) : await options.api!.getCompanyStats(args.countryId); return { status: 'success', source: { endpoint, fetchedAt: new Date().toISOString() }, data }; } catch (error) { return apiErrorResult(error); } } });
    tools.push({ name: 'get_market_data', description: 'Retrieve documented current market listings, an item order book, or price history. Never infer profitability from prices alone.', parameters: { type: 'object', properties: { view: { type: 'string', enum: ['overview', 'orders', 'history'] }, itemCode: { type: 'string', minLength: 1, maxLength: 80 }, hours: { type: 'integer', minimum: 1, maximum: 720 }, market: { type: 'string', minLength: 1, maxLength: 80 } }, required: ['view'], additionalProperties: false }, execute: async (raw) => { const args = z.object({ view: z.enum(['overview', 'orders', 'history']), itemCode: z.string().min(1).max(80).optional(), hours: z.number().int().min(1).max(720).optional(), market: z.string().min(1).max(80).optional() }).strict().parse(raw); if (args.view !== 'overview' && !args.itemCode) return { status: 'needs_clarification', required: 'itemCode' }; try { const data = args.view === 'overview' ? await options.api!.getMarket(args.market) : args.view === 'orders' ? await options.api!.getMarketOrders(args.itemCode!, args.market) : await options.api!.getMarketHistory(args.itemCode!, args.hours, args.market); return { status: 'success', source: { endpoint: args.view === 'overview' ? '/market' : `/market/${args.itemCode}/${args.view}`, fetchedAt: new Date().toISOString() }, data }; } catch (error) { return apiErrorResult(error); } } });
  }
  return tools;
}

export function bm25Search(chunks: KnowledgeChunk[], query: string, limit = 5): Array<KnowledgeChunk & { score: number }> {
  const terms = expandTerms(new Set(tokenize(query)));
  if (!terms.size) return [];
  const docs = chunks.map((chunk) => tokenize(`${chunk.heading} ${chunk.content}`));
  const avgLength = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  return chunks.map((chunk, index) => {
    const doc = docs[index]!;
    let score = 0;
    for (const term of terms) {
      const tf = doc.filter((word) => word === term).length;
      if (!tf) continue;
      const df = docs.filter((item) => item.includes(term)).length;
      const idf = Math.log(1 + (docs.length - df + 0.5) / (df + 0.5));
      score += idf * (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * doc.length / Math.max(1, avgLength)));
    }
    return { ...chunk, score };
  }).filter((row) => row.score >= 0.15).sort((a, b) => b.score - a.score).slice(0, limit);
}
function tokenize(value: string): string[] { return value.toLocaleLowerCase('und').normalize('NFKC').replace(/[أإآٱ]/gu, 'ا').replace(/ة/gu, 'ه').replace(/ى/gu, 'ي').match(/[\p{L}\p{N}]{2,}/gu) ?? []; }
function expandTerms(terms: Set<string>): Set<string> {
  const groups = [['company', 'companies', 'business', 'شركة', 'شركات', 'مصنع'], ['war', 'battle', 'combat', 'حرب', 'معركة', 'قتال'], ['damage', 'ضرر', 'أضرار'], ['work', 'worked', 'عمل', 'شغل'], ['gold', 'ذهب', 'الذهب'], ['country', 'nation', 'دولة', 'بلد', 'مصر', 'egypt', 'egyptian', 'masr'], ['citizen', 'citizens', 'population', 'مواطن', 'مواطنين', 'سكان'], ['government', 'president', 'حكومة', 'رئيس'], ['level', 'مستوى', 'لفل']];
  const expanded = new Set(terms);
  for (const group of groups) if (group.some((term) => terms.has(term))) for (const term of group) expanded.add(term);
  return expanded;
}
function apiErrorResult(error: unknown, endpoint?: string): Record<string, unknown> { return { status: error instanceof AonApiError ? error.kind : 'unavailable', source: { endpoint, fetchedAt: new Date().toISOString() }, error: error instanceof AonApiError ? error.kind : 'request_failed' }; }
