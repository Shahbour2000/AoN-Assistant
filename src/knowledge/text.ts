/**
 * Text normalisation shared by indexing and querying. Arabic is the hard part: players write Egyptian dialect with
 * inconsistent spelling (ة/ه, ي/ى, أ/ا, optional diacritics) and the wiki uses Modern Standard Arabic. We normalise
 * orthography and apply a *light* stemmer so الشركات / شركة / شركات / للشركات all land on the same index term.
 */

const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const EXTENDED_INDIC = '۰۱۲۳۴۵۶۷۸۹';

export function normalizeArabic(text: string): string {
  return text.normalize('NFKC').toLocaleLowerCase('und')
    .replace(/[ً-ٰٟۖ-ۭـ]/gu, '')
    .replace(/[أإآٱ]/gu, 'ا').replace(/ى/gu, 'ي').replace(/ؤ/gu, 'و').replace(/ئ/gu, 'ي').replace(/ة/gu, 'ه')
    .replace(/[٠-٩]/gu, (d) => String(ARABIC_INDIC.indexOf(d)))
    .replace(/[۰-۹]/gu, (d) => String(EXTENDED_INDIC.indexOf(d)))
    .replace(/[گ]/gu, 'ك').replace(/[چ]/gu, 'ج').replace(/[پ]/gu, 'ب').replace(/[ڤ]/gu, 'ف');
}

const ARABIC_RE = /[؀-ۿ]/u;
const ARABIC_PREFIXES = ['وبال', 'وال', 'بال', 'كال', 'فال', 'لل', 'ال', 'ول', 'وب', 'وس', 'ب', 'ل', 'و', 'ف', 'س'];
const ARABIC_SUFFIXES = ['ات', 'ون', 'ين', 'ان', 'ها', 'هم', 'ية', 'يه', 'تي', 'ني', 'نا', 'كم', 'ه', 'ي', 'ا'];

export function stemArabic(token: string): string {
  let word = token;
  for (const prefix of ARABIC_PREFIXES) {
    if (word.startsWith(prefix) && word.length - prefix.length >= 3) { word = word.slice(prefix.length); break; }
  }
  for (const suffix of ARABIC_SUFFIXES) {
    if (word.endsWith(suffix) && word.length - suffix.length >= 3) { word = word.slice(0, -suffix.length); break; }
  }
  return word;
}

export function stemEnglish(token: string): string {
  if (token.length <= 3) return token;
  if (token.endsWith('ies') && token.length > 4) return `${token.slice(0, -3)}y`;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) return token.slice(0, -suffix.length);
  }
  return token;
}

/** Very small stop list: only words that carry no retrieval signal in either language. Content words are never removed. */
const STOP = new Set(['the', 'and', 'for', 'are', 'was', 'with', 'that', 'this', 'what', 'how', 'can', 'you', 'your', 'من', 'في', 'علي', 'الي', 'عن', 'هو', 'هي', 'ما', 'ماذا', 'كيف', 'هل', 'ان', 'او', 'ايه', 'ازاي', 'يعني', 'طب', 'طيب', 'لو', 'انا', 'انت', 'هوا', 'دي', 'ده', 'دا', 'بتاع', 'بتاعه', 'عايز', 'عاوز', 'محتاج', 'كام', 'فين']);

export function tokenize(text: string): string[] {
  const normalized = normalizeArabic(text);
  const raw = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const token of raw) {
    if (STOP.has(token)) continue;
    if (ARABIC_RE.test(token)) {
      const stem = stemArabic(token);
      if (stem.length >= 2 && !STOP.has(stem)) tokens.push(stem);
    } else if (/^\d+$/u.test(token)) tokens.push(token);
    else if (token.length >= 2) tokens.push(stemEnglish(token));
  }
  return tokens;
}

export function hasArabic(text: string): boolean { return ARABIC_RE.test(text); }
