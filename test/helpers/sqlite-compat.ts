import { DatabaseSync } from 'node:sqlite';
import { runMigrations } from '../../src/database/migrations.js';

/**
 * Opens an in-memory SQLite database through Node's built-in `node:sqlite` and exposes the small part of the
 * better-sqlite3 API that the repositories use. Lets the memory/service tests run without the native module.
 * (foundation.test.ts still exercises the real better-sqlite3 path.)
 */
export function openTestDatabase(): any {
  const raw = new DatabaseSync(':memory:');
  raw.exec('PRAGMA foreign_keys = ON');
  const db = {
    prepare: (sql: string) => raw.prepare(sql),
    exec: (sql: string) => raw.exec(sql),
    pragma: (sql: string) => raw.exec(`PRAGMA ${sql}`),
    transaction: <T extends unknown[], R>(fn: (...args: T) => R) => (...args: T): R => {
      raw.exec('BEGIN');
      try { const result = fn(...args); raw.exec('COMMIT'); return result; } catch (error) { raw.exec('ROLLBACK'); throw error; }
    },
    close: () => raw.close(),
  };
  runMigrations(db as never);
  return db;
}
