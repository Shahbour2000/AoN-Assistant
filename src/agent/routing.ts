import { normalizeArabic } from '../knowledge/text.js';

/**
 * Cheap, local decisions that save model tokens. They never decide what is TRUE (that always comes from the wiki / live data);
 * they only decide how much context the model needs, and they err on the side of giving the model more.
 */
const norm = (text: string) => normalizeArabic(text).replace(/[^\p{L}\p{N}_\s]/gu, ' ').replace(/\s+/gu, ' ').trim();

/** Words that may appear in a pure greeting / thanks. A message is small talk only if EVERY word is in this list. */
const SMALL_TALK_WORDS = new Set([
  'سلام', 'السلام', 'عليكم', 'عليك', 'ورحمه', 'الله', 'وبركاته', 'وعليكم', 'اهلا', 'اهلين', 'مرحبا', 'مرحبتين', 'هلا', 'هاي', 'هالو', 'صباح', 'مساء', 'الخير', 'النور', 'ازيك', 'ازيكم', 'عامل', 'عاملين', 'اخبارك', 'اخبار', 'كيفك', 'كيف', 'حالك', 'شكرا', 'شكراا', 'متشكر', 'مشكور', 'تسلم', 'تسلمي', 'يسلمو', 'ايديك', 'جزاك', 'خيرا', 'يا', 'باشا', 'بيه', 'حبيبي', 'صديقي', 'اخي', 'بك', 'ليك', 'لك', 'جدا', 'كتير', 'اوي', 'بيك', 'معاك', 'الف', 'تمام', 'ماشي', 'اوكي', 'اوكيه', 'ok', 'okay', 'hi', 'hello', 'hey', 'yo', 'thanks', 'thank', 'you', 'thx', 'good', 'morning', 'evening', 'how', 'are', 'bye', 'مع', 'السلامه', 'سلامتك', 'تصبح', 'علي', 'خير', 'بوت', 'مساعد',
].map(norm));

export function isSmallTalk(question: string): boolean {
  const words = norm(question).split(' ').filter(Boolean);
  return words.length > 0 && words.length <= 9 && words.every((word) => SMALL_TALK_WORDS.has(word) || /^(ه|ا)+$/u.test(word));
}

const DATA_INTENT = new RegExp([
  '\\b(player|players|username|profile|stats?|statistics|leaderboard|ranking|rankings|rank|top \\d+|country|countries|market|prices?|wars?|battles?|alliance|alliances|online|right now|currently|my account|my company|my companies|cmp_\\w+)\\b',
  '(لاعب|اللاعب|لاعبين|بروفايل|حسابي|حسابه|احصايات|احصائيات|ترتيب|الترتيب|اعلي|اعلا|دوله|الدوله|دول|سعر|اسعار|الاسعار|السوق|سوق|حرب|حروب|معركه|معارك|تحالف|دلوقتي|حاليا|الان|شركتي|شركاتي|شركته|username)',
].join('|'), 'iu');

/**
 * Does the question look like it needs LIVE game data (a player, country, price, ranking...)? When it clearly does not, the model is
 * only offered the wiki and calculator tools (when the wiki already answered with high confidence). A Latin word inside an Arabic
 * question is treated as a possible username, so such questions keep the full tool set.
 */
export function needsLiveData(question: string): boolean {
  const text = norm(question);
  if (DATA_INTENT.test(text)) return true;
  return /[؀-ۿ]/u.test(question) && /\b[A-Za-z][A-Za-z0-9_]{2,}\b/u.test(question);
}
