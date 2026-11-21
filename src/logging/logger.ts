type Level = 'debug' | 'info' | 'warn' | 'error';
/** Field names that are dropped from log details. (Plain counters such as promptTokens are fine and are kept.) */
const SECRET_KEY = /secret|authorization|password|api.?key|^token$|(access|auth|bot|bearer|discord)[-_ ]?token/i;
const priorities: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
let threshold: Level = 'info';

export const logger = {
  configure(level: Level) { threshold = level; },
  debug(message: string, details?: Record<string, unknown>) { write('debug', message, details); },
  info(message: string, details?: Record<string, unknown>) { write('info', message, details); },
  warn(message: string, details?: Record<string, unknown>) { write('warn', message, details); },
  error(message: string, details?: Record<string, unknown>) { write('error', message, details); },
};

function write(level: Level, message: string, details?: Record<string, unknown>) {
  if (priorities[level] < priorities[threshold]) return;
  const safeDetails = details && Object.fromEntries(Object.entries(details)
    .filter(([key]) => !SECRET_KEY.test(key))
    .map(([key, value]) => [key, sanitize(value)]));
  console[level](`[${new Date().toISOString()}] ${message}`, safeDetails ?? '');
}

function sanitize(value: unknown): unknown {
  if (typeof value === 'string') {
    let safe = value.replace(/AIza[0-9A-Za-z_-]{20,}/gu, '[REDACTED_API_KEY]')
      .replace(/(Bearer\s+)[^\s"']+/giu, '$1[REDACTED]')
      .replace(/([?&](?:key|api_key|token)=)[^&\s]+/giu, '$1[REDACTED]');
    // Redact the actual value of every configured credential, whatever provider it belongs to.
    const configuredKeys = Object.entries(process.env).filter(([name, value]) => /(_KEY|_TOKEN|_SECRET)$/u.test(name) && (value?.length ?? 0) >= 8).map(([, value]) => value as string);
    for (const configuredKey of configuredKeys) safe = safe.replaceAll(configuredKey, '[REDACTED_API_KEY]');
    const configuredToken = process.env.DISCORD_TOKEN;
    if (configuredToken) safe = safe.replaceAll(configuredToken, '[REDACTED_TOKEN]');
    return safe;
  }
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEY.test(key)).map(([key, item]) => [key, sanitize(item)]));
  return value;
}
