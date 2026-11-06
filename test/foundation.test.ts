import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database/database.js';
import { GuildSettingsRepository, MessageRepository, SessionRepository } from '../src/database/repositories.js';
import { loadKnowledge, normalizeArabic, retrieve } from '../src/knowledge/retrieval.js';

test('SQLite initializes guild settings and session tables', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-db-'));
  const db = await openDatabase(path.join(directory, 'nested', 'test.sqlite'));
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => (row as { name: string }).name);
    assert.ok(tables.includes('guild_settings'));
    assert.ok(tables.includes('sessions'));
    assert.ok(tables.includes('conversation_messages'));
    assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('database migrations run once and repositories perform CRUD with cascading deletion', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-crud-'));
  const filename = path.join(directory, 'db.sqlite');
  const db = await openDatabase(filename);
  try {
    const settings = new GuildSettingsRepository(db);
    assert.equal(settings.get('guild-a'), undefined);
    assert.equal(settings.upsert({ guildId: 'guild-a', inactivityMinutes: 45 }).inactivityMinutes, 45);
    assert.equal(settings.upsert({ guildId: 'guild-a', buttonLabel: 'Open' }).inactivityMinutes, 45);
    assert.equal(settings.get('guild-a')?.buttonLabel, 'Open');

    const sessions = new SessionRepository(db);
    const session = { id: 'session-a', guildId: 'guild-a', userId: 'user-a', channelId: 'channel-a', lastActivityAt: '2026-01-01T00:00:00Z', createdAt: '2026-01-01T00:00:00Z' };
    sessions.create(session);
    assert.equal(sessions.getByUser('guild-a', 'user-a')?.id, session.id);
    assert.equal(sessions.getByChannel('channel-a')?.userId, 'user-a');
    assert.equal(sessions.list('guild-a').length, 1);
    assert.equal(sessions.touch(session.id, '2026-01-01T00:01:00Z'), true);
    assert.equal(sessions.getById(session.id)?.lastActivityAt, '2026-01-01T00:01:00Z');

    const messages = new MessageRepository(db);
    messages.append(session.id, 'user', 'Question');
    messages.append(session.id, 'model', 'Answer');
    assert.deepEqual(messages.list(session.id).map((message) => message.content), ['Question', 'Answer']);
    assert.equal(sessions.delete(session.id), true);
    assert.equal(messages.list(session.id).length, 0);
    assert.equal(settings.delete('guild-a'), true);
    assert.equal(settings.delete('guild-a'), false);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
  const reopened = await openDatabase(filename);
  reopened.close();
});

test('knowledge loader discovers Markdown recursively and retains heading/source', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-knowledge-'));
  try {
    await mkdir(path.join(directory, 'guides'));
    await writeFile(path.join(directory, 'guides', 'start.md'), '# Getting Started\nBuild a town center.\n\n## Economy\nGather food and wood.', 'utf8');
    await writeFile(path.join(directory, 'ignored.txt'), 'not markdown', 'utf8');
    const chunks = await loadKnowledge(directory);
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]?.source, 'guides/start.md');
    assert.equal(chunks[0]?.heading, 'Getting Started');
    assert.equal(retrieve(chunks, 'gather wood')[0]?.heading, 'Economy');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('knowledge chunks long sections and retrieves normalized Arabic terms', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-arabic-'));
  try {
    const paragraph = 'تُنتج المدينة الطعام والموارد اللازمة للاعب. '.repeat(30);
    await writeFile(path.join(directory, 'economy.md'), `# الاقتصاد\n${paragraph}`, 'utf8');
    const chunks = await loadKnowledge(directory, { maxChunkCharacters: 200, overlapCharacters: 20 });
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.content.length <= 200 && chunk.heading === 'الاقتصاد'));
    assert.equal(normalizeArabic('إنتاجُ الأطعمةِ في المدينة'), normalizeArabic('انتاج الاطعمه في المدينه'));
    assert.equal(retrieve(chunks, 'كيف يتم انتاج الطعام؟')[0]?.source, 'economy.md');
    assert.deepEqual(await loadKnowledge(path.join(directory, 'missing')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('base environment works without credentials; feature requirements are checked when needed', async () => {
  const { loadConfig } = await import('../src/config/env.js');
  const original = { ...process.env };
  try {
    delete process.env.DISCORD_TOKEN;
    delete process.env.DISCORD_CLIENT_ID;
    delete process.env.GEMINI_API_KEY;
    const config = loadConfig();
    assert.equal(config.DISCORD_TOKEN, undefined);
    assert.equal(config.GEMINI_MODEL, 'gemini-2.5-flash');
    const { requireDiscordConfig, requireGeminiConfig } = await import('../src/config/env.js');
    assert.throws(() => requireDiscordConfig(config), /Discord configuration is required/);
    assert.throws(() => requireGeminiConfig(config), /GEMINI_API_KEY is required/);
    process.env.DISCORD_TOKEN = 'local-test-token';
    process.env.DISCORD_CLIENT_ID = 'local-test-client';
    process.env.GEMINI_API_KEY = 'local-test-key';
    assert.equal(requireDiscordConfig(loadConfig()).token, 'local-test-token');
    assert.equal(requireGeminiConfig(loadConfig()).model, 'gemini-2.5-flash');
  } finally {
    process.env = original;
  }
});
