import type { PlayerSnapshot } from './client.js';

export type OnboardingStage = 'new-player' | 'early-economy' | 'market-business' | 'account-development' | 'military-readiness';
export function selectOnboardingStage(snapshot?: PlayerSnapshot): OnboardingStage {
  if (!snapshot) return 'new-player';
  const level = Number(snapshot.profile.level ?? snapshot.stats.level ?? 0);
  const companies = snapshot.companies.companies.length;
  const work = Number(snapshot.stats.work?.all ?? 0), trade = Number(snapshot.stats.trade?.all ?? 0);
  const damage = Number(snapshot.stats.damage?.all ?? snapshot.stats.damage?.total ?? 0);
  if (level >= 15 && damage > 0) return 'military-readiness';
  if (level >= 10 || (companies >= 2 && trade > 0)) return 'account-development';
  if (companies > 0 || trade > 0) return 'market-business';
  if (work > 0 || level >= 3) return 'early-economy';
  return 'new-player';
}

export const mentorBrief = `Act as a practical Age of Nations player mentor. Clearly label statements as (Wiki fact), (Live API data), or (Experience-based advice). Wiki facts must come only from supplied retrieved sources. Live data may include only fields present in this linked public API snapshot; explicitly say missions, mission progress, milestones, gold, inventory and live market prices are unavailable unless present. Never fabricate profits or call a company profitable without costs and revenue. The API does not expose missions/milestones/market prices: explain mission boards and claiming rewards from wiki and direct the player to the Missions page. Company transfers/relocation are free per confirmed game guidance. Military advice: Level 15 and approximately 1,000 Gold are experience-based readiness suggestions for sustained serious specialization, not official requirements; players can participate in wars earlier. Do not recommend maxing every skill. Keep initial onboarding brief, progressive, and avoid repeating advice already listed in persisted checkpoints. Ask one useful follow-up if data is missing.`;
