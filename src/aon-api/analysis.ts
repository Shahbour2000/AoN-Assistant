import type { PlayerSnapshot } from './client.js';

export type PlayerFocus = 'war-focused' | 'economy-focused' | 'hybrid' | 'insufficient-data';
export interface PlayerAnalysis {
  /** Recent momentum relative to each activity category's own 30-day pace. */
  currentFocus: PlayerFocus;
  /** Lifetime specialization cannot be compared from unlike API units without a validated common scale. */
  historicalSpecialization: 'insufficient-data';
  warPaceIndex?: number;
  economyPaceIndex?: number;
  explanation: string;
  historicalExplanation: string;
}

const number = (value: string | number | undefined): number | undefined => {
  if (value === undefined || (typeof value === 'string' && !/^\d+(?:\.\d+)?$/u.test(value))) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
};

/**
 * Current focus is a recent-momentum heuristic, not a comparison of raw damage
 * points with work/trade counts. Each weekly value is normalized against its
 * own 30-day category total, then compared as a dimensionless pace index.
 */
export function analyzePlayer(snapshot: PlayerSnapshot, relativeMargin = 0.25): PlayerAnalysis {
  if (!Number.isFinite(relativeMargin) || relativeMargin < 0 || relativeMargin >= 1) throw new Error('Relative margin must be between 0 and 1');
  const stats = snapshot.stats;
  const warWeek = number(stats.damage?.week);
  const warMonth = number(stats.damage?.month);
  const workWeek = number(stats.work?.week);
  const tradeWeek = number(stats.trade?.week);
  const workMonth = number(stats.work?.month);
  const tradeMonth = number(stats.trade?.month);
  const economyWeek = workWeek !== undefined && tradeWeek !== undefined ? workWeek + tradeWeek : undefined;
  const economyMonth = workMonth !== undefined && tradeMonth !== undefined ? workMonth + tradeMonth : undefined;
  const validWindows = warWeek !== undefined && warMonth !== undefined && warMonth > 0 && warWeek <= warMonth
    && economyWeek !== undefined && economyMonth !== undefined && economyMonth > 0 && economyWeek <= economyMonth;

  if (!validWindows) return insufficientAnalysis();

  const warPaceIndex = (warWeek! / warMonth!) / (7 / 30);
  const economyPaceIndex = (economyWeek! / economyMonth!) / (7 / 30);
  const relativeWarPace = warPaceIndex / economyPaceIndex;
  const currentFocus: PlayerFocus = relativeWarPace >= 1 + relativeMargin ? 'war-focused'
    : relativeWarPace <= 1 / (1 + relativeMargin) ? 'economy-focused' : 'hybrid';

  return {
    currentFocus,
    historicalSpecialization: 'insufficient-data',
    warPaceIndex,
    economyPaceIndex,
    explanation: `Recent momentum is ${currentFocus}. War pace index: ${warPaceIndex.toFixed(2)}; economy pace index: ${economyPaceIndex.toFixed(2)}. Each index compares its own 7-day amount with its 30-day average weekly pace; raw damage and work/trade counts are not compared directly.`,
    historicalExplanation: 'Historical specialization is undetermined: lifetime damage uses damage points, while work and trade use activity counts. The API provides no validated shared scale or comparison cohort for those unlike units.',
  };
}

function insufficientAnalysis(): PlayerAnalysis {
  return {
    currentFocus: 'insufficient-data',
    historicalSpecialization: 'insufficient-data',
    explanation: 'Current activity cannot be classified because weekly or 30-day data is missing, zero, malformed, or inconsistent.',
    historicalExplanation: 'Historical specialization is undetermined because lifetime damage points and work/trade counts have no validated common comparison scale.',
  };
}

export function buildPlayerContext(snapshot: PlayerSnapshot, options: { includeCompanies?: boolean } = {}): string {
  const p = snapshot.profile;
  const s = snapshot.stats;
  const a = analyzePlayer(snapshot);
  const rank = p.rank && typeof p.rank === 'object' ? (p.rank as { code?: unknown }).code : undefined;
  const safeCompanyList = snapshot.companies.companies.slice(0, 5).map((company) => ({
    name: boundedText(company.name), itemCode: boundedText(company.itemCode), level: company.level, workers: company.workers,
    investedMoney: company.investedMoney, investedSteel: company.investedSteel, points: company.points,
  }));
  return JSON.stringify({
    dataKind: 'public Age of Nations API data; linked account ownership is not verified', fetchedAt: snapshot.fetchedAt,
    profile: { username: boundedText(p.username), level: p.level, xp: p.xp, xpLevelStart: p.xpLevelStart, xpNextLevel: p.xpNextLevel, prestige: p.prestige, rank: boundedText(rank), countryId: boundedText(p.countryId) },
    stats: { damage: s.damage, work: s.work, trade: s.trade, companies: s.companies },
    ...(options.includeCompanies === false ? {} : { companyList: safeCompanyList, companyListTotal: snapshot.companies.total ?? snapshot.companies.companies.length }),
    analysis: a,
  });
}

function boundedText(value: unknown): string | undefined { return typeof value === 'string' ? value.replace(/[\u0000-\u001f]/gu, ' ').slice(0, 80) : undefined; }
