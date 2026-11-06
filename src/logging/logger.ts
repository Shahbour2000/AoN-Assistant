type Level = 'debug' | 'info' | 'warn' | 'error';
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
  const safeDetails = details && Object.fromEntries(Object.entries(details).filter(([key]) => !/token|secret|key|authorization/i.test(key)));
  console[level](`[${new Date().toISOString()}] ${message}`, safeDetails ?? '');
}
