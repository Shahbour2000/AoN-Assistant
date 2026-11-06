import type Database from 'better-sqlite3';

interface Migration { version: number; sql: string; }

const migrations: Migration[] = [
  { version: 1, sql: `CREATE TABLE guild_settings (
    guild_id TEXT PRIMARY KEY, ticket_category_id TEXT, entry_channel_id TEXT,
    embed_title TEXT, embed_description TEXT, embed_color TEXT,
    embed_image_url TEXT, embed_thumbnail_url TEXT, button_label TEXT,
    inactivity_minutes INTEGER NOT NULL DEFAULT 60 CHECK(inactivity_minutes > 0)
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, user_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE, last_activity_at TEXT NOT NULL,
    created_at TEXT NOT NULL, UNIQUE(guild_id, user_id)
  );
  CREATE INDEX sessions_guild_activity_idx ON sessions(guild_id, last_activity_at);
  CREATE TABLE conversation_messages (
    session_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0),
    role TEXT NOT NULL CHECK(role IN ('user', 'model')), content TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY(session_id, ordinal),
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );` },
  { version: 2, sql: `ALTER TABLE guild_settings ADD COLUMN ticket_channel_id TEXT;
  ALTER TABLE guild_settings ADD COLUMN ticket_admin_role_ids TEXT NOT NULL DEFAULT '';
  CREATE TABLE tickets (
    id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, owner_id TEXT NOT NULL,
    channel_id TEXT NOT NULL UNIQUE, session_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK(status IN ('open', 'closed')),
    created_at TEXT NOT NULL, closed_at TEXT,
    FOREIGN KEY(session_id) REFERENCES sessions(id) ON DELETE CASCADE
  );
  CREATE UNIQUE INDEX one_open_ticket_per_owner ON tickets(guild_id, owner_id) WHERE status = 'open';
  CREATE INDEX tickets_guild_status_idx ON tickets(guild_id, status);` },
];

export function runMigrations(db: Database.Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = db.prepare('SELECT version FROM schema_migrations').all().map((row) => (row as { version: number }).version);
  for (const migration of migrations) {
    if (applied.includes(migration.version)) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(migration.version, new Date().toISOString());
    })();
  }
}
