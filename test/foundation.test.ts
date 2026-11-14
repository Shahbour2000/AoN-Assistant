import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { openDatabase } from '../src/database/database.js';
import { GuildSettingsRepository, MessageRepository, SessionRepository } from '../src/database/repositories.js';
import { KnowledgeBase, markdownFiles, normalizeArabic } from '../src/knowledge/index.js';
import { buildLlm } from '../src/llm/presets.js';

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

test('knowledge base discovers Markdown recursively, keeps source/heading, and ignores non-Markdown', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'aon-knowledge-'));
  try {
    await mkdir(path.join(directory, 'guides'));
    await writeFile(path.join(directory, 'guides', 'start.md'), '# Getting Started\nBuild a town center.\n\n## Economy\nGather food and wood.', 'utf8');
    await writeFile(path.join(directory, 'ignored.txt'), 'not markdown', 'utf8');
    const kb = await KnowledgeBase.create({ dir: directory });
    assert.deepEqual(kb.documents, ['guides/start.md']);
    const result = await kb.search(['gather wood']);
    assert.equal(result.hits[0]?.source, 'guides/start.md');
    assert.equal(result.hits[0]?.heading, 'Getting Started > Economy');
    assert.deepEqual(await markdownFiles(path.join(directory, 'missing')), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('Arabic orthography variants normalise to the same search terms', () => {
  assert.equal(normalizeArabic('إنتاجُ الأطعمةِ في المدينة'), normalizeArabic('انتاج الاطعمه في المدينه'));
});

test('all local Age of Nations wiki files load and are retrievable by their own headings', async () => {
  const kb = await KnowledgeBase.create({ dir: path.resolve('knowledge') });
  for (const file of ['01-basics.md', '02-economy.md', '03-war.md', '04-politics.md', '05-community.md']) assert.ok(kb.documents.includes(file), `${file} should be discovered`);
  assert.ok(kb.chunkCount > 100);
});

test('LLM provider configuration is explicit, validates keys, and keeps legacy GROQ_API_KEY working', async () => {
  assert.throws(() => buildLlm({}), /LLM_PRIMARY/);
  assert.throws(() => buildLlm({ LLM_PRIMARY: 'mistral' }), /MISTRAL_API_KEY/);
  assert.throws(() => buildLlm({ LLM_PRIMARY: 'openrouter:openai/gpt-oss-120b', OPENROUTER_API_KEY: 'k' }), /:free/);
  assert.deepEqual(buildLlm({ GROQ_API_KEY: 'k' }).specs, [{ provider: 'groq', model: 'qwen/qwen3.8-27b' }]);
  const warnings: string[] = [];
  const built = buildLlm({ LLM_PRIMARY: 'mistral:mistral-large-latest', MISTRAL_API_KEY: 'k', LLM_BACKUP: 'groq:openai/gpt-oss-120b' }, undefined, (m) => warnings.push(m));
  assert.equal(built.specs.length, 1);
  assert.match(warnings[0] ?? '', /GROQ_API_KEY/);
});
