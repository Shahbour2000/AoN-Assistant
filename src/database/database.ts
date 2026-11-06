import Database from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runMigrations } from './migrations.js';

export async function openDatabase(filename: string): Promise<Database.Database> {
  await mkdir(path.dirname(path.resolve(filename)), { recursive: true });
  const db = new Database(filename);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  try { runMigrations(db); }
  catch (error) { db.close(); throw error; }
  return db;
}
