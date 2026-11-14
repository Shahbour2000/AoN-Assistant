/** Helpers that keep tool results small and honest before they reach the model. */

const DROP_KEYS = new Set(['avatarUrl', 'bannerUrl', 'nameStyle', 'staffBadge', 'discordUrl', 'viewer', 'diplomaticHistory', 'developmentHistory', 'controlledRegions', 'history', 'serverTime', 'revision']);

/**
 * Shrink an arbitrary JSON value to roughly `maxChars` of serialized text. Long arrays are cut (with an explicit
 * `…N more` marker so the model never mistakes a truncated list for a complete one), long strings are shortened, nulls
 * and noisy keys are dropped. The result is always valid JSON when serialized.
 */
export function compact(value: unknown, maxChars = 4500): unknown {
  let arrayLimit = 12;
  let depthLimit = 5;
  let result = shrink(value, arrayLimit, depthLimit);
  while (JSON.stringify(result).length > maxChars && (arrayLimit > 2 || depthLimit > 2)) {
    arrayLimit = Math.max(2, Math.floor(arrayLimit / 2));
    depthLimit = Math.max(2, depthLimit - 1);
    result = shrink(value, arrayLimit, depthLimit);
  }
  return result;
}

function shrink(value: unknown, arrayLimit: number, depth: number): unknown {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}…` : value;
  if (typeof value !== 'object') return value;
  if (depth <= 0) return Array.isArray(value) ? `[${value.length} items]` : '{…}';
  if (Array.isArray(value)) {
    const items = value.slice(0, arrayLimit).map((item) => shrink(item, arrayLimit, depth - 1)).filter((item) => item !== undefined);
    if (value.length > arrayLimit) items.push(`…${value.length - arrayLimit} more (list truncated, total ${value.length})`);
    return items;
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(key)) continue;
    const shrunk = shrink(item, arrayLimit, depth - 1);
    if (shrunk === undefined || (Array.isArray(shrunk) && shrunk.length === 0)) continue;
    out[key] = shrunk;
  }
  return out;
}

/** Game money is a string in 1/10,000 gold ("12345" = 1.2345 gold). Convert to a plain decimal string. */
export function toGold(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) value = String(Math.trunc(value));
  if (typeof value !== 'string' || !/^-?\d+$/u.test(value)) return undefined;
  const negative = value.startsWith('-');
  const digits = value.replace('-', '').padStart(5, '0');
  const whole = digits.slice(0, -4).replace(/^0+(?=\d)/u, '');
  const fraction = digits.slice(-4).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/** Add a `<key>Gold` sibling next to every listed money key, at any depth. The original raw value is kept. */
export function addGold(value: unknown, moneyKeys: ReadonlySet<string>): unknown {
  if (Array.isArray(value)) return value.map((item) => addGold(item, moneyKeys));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[key] = addGold(item, moneyKeys);
    if (moneyKeys.has(key)) { const gold = toGold(item); if (gold !== undefined) out[`${key}Gold`] = gold; }
  }
  return out;
}

export const MONEY_NOTE = 'Money values are strings in 1/10,000 gold (e.g. "12345" = 1.2345 gold). Fields ending in "Gold" are already converted.';
