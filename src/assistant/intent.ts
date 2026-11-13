export type AssistantIntent = 'casual' | 'general' | 'game-mechanics' | 'game-news' | 'player-capability' | 'player-lookup' | 'player-followup';
export function classifyIntent(text: string, hasSelectedPlayer = false): AssistantIntent {
  const s = text.trim().toLocaleLowerCase();
  if (/(تعرف|تقدر|ممكن).{0,45}(بيانات لاعب|لاعب معين|player(?:'s)? data|retrieve a player|look up a player|player information)/iu.test(s)) return 'player-capability';
  if (/^(?:hey[,! ]+)?(?:how are you|how's it going|what's up)[؟!?.\s😂🤣]*$/iu.test(s)) return 'casual';
  if (/^(إيه الأخبار عامل إيه|عامل إيه|ازيك|إزيك|صباح الخير|مساء الخير|hello|hi|hey|how are you)[؟!?.\s😂🤣]*$/iu.test(s)) return 'casual';
  if (/(آخر أخبار اللعبة|اخبار اللعبة|أخبار اللعبة|game news|latest news)/iu.test(s)) return 'game-news';
  if (/(ابحث عن|دور على|هات بيانات|هات إحصائيات|بيانات اللاعب|بيانات لاعب|lookup|look up|find player|player\s*[:：])\s*[\p{L}\p{N}_-]{2,40}/iu.test(s) || /[\p{L}\p{N}_-]{2,40}\s+(?:مستواه|مستوى اللاعب|في أي دولة)/iu.test(s)) return 'player-lookup';
  if (hasSelectedPlayer && /(مستواه|مستوى اللاعب|الضرر بتاعه|damage|level|companies|شركاته|بلده|أي دولة|إحصائياته|احصائياته|country|work|trade|military|economic|his\s+(?:level|damage|country|work|stats)|what about his)/iu.test(s)) return 'player-followup';
  if (/(age of nations|aon|اللعبة|الذهب|ضرر|damage|company|شركة|mission|مهمة|level|مستوى|حرب|معركة|قانون|انتخابات)/iu.test(s)) return 'game-mechanics';
  if (/\b(my damage|my level|my account|my companies|player stats)\b|حسابي|مستواي|ضرري/iu.test(s)) return 'player-followup';
  return /[؟?]|^(what|why|how|who|when|where|can|could|what's)\b/iu.test(s) ? 'general' : 'casual';
}
export function extractPlayerUsername(text: string, awaitingUsername: boolean): string | undefined {
  const explicit = text.match(/(?:ابحث عن|دور على|هات بيانات|هات إحصائيات|بيانات اللاعب|بيانات لاعب|lookup|look up|find player|player\s*[:：])\s*([\p{L}\p{N}_-]{2,40})/iu)?.[1]
    ?? text.match(/([\p{L}\p{N}_-]{2,40})\s+(?:مستواه|مستوى اللاعب|كام|في أي دولة)/iu)?.[1]
    ?? text.match(/(?:statistics|stats|level|country|damage)\s+(?:for|of)\s+([\p{L}\p{N}_-]{2,40})/iu)?.[1]
    ?? text.match(/(?:get|fetch|show)\s+([\p{L}\p{N}_-]{2,40})(?:'s)?\s+(?:data|stats|profile|level)/iu)?.[1]
    ?? text.match(/([\p{L}\p{N}_-]{2,40})['’]s\s+(?:data|stats|profile|level)/iu)?.[1]
    ?? text.match(/^(?:my username is |اسم(?:ي)?(?: في اللعبة)?\s*[:：]?\s*)([\p{L}\p{N}_-]{2,40})$/iu)?.[1];
  if (explicit) return explicit;
  const bare = text.trim();
  return awaitingUsername && /^[\p{L}\p{N}_-]{2,40}$/u.test(bare) ? bare : undefined;
}
