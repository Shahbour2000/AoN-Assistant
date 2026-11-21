import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { loadConfig } from '../src/config/env.js';
import { buildEmbedder, buildLlm } from '../src/llm/presets.js';

async function sourceFiles(directory: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}
function parseEnvFile(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) { const m = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line.trim()); if (m) result[m[1]!] = m[2]!; }
  return result;
}

test('.env.example parses with the real config loader exactly as shipped (blank = not set) and contains no secrets or placeholders', async () => {
  const example = parseEnvFile(await readFile('.env.example', 'utf8'));
  const config = loadConfig(example);
  assert.equal(config.LOG_LEVEL, 'info');
  assert.equal(config.DISCORD_TOKEN, undefined);
  assert.equal(config.LLM_PRIMARY, undefined);
  for (const [name, value] of Object.entries(example)) if (/KEY|TOKEN/u.test(name)) assert.equal(value, '', `${name} must be blank in the template`);
});

test('an old .env (Discord + Groq only) still works unchanged: Groq is picked automatically, with a warning, and nothing else is required', () => {
  const old = { DISCORD_TOKEN: 'x', DISCORD_CLIENT_ID: 'y', GROQ_API_KEY: 'gsk_abcdefgh', GROQ_MODEL: 'qwen/qwen3.8-27b', DATABASE_PATH: './data/aon-assistant.sqlite', KNOWLEDGE_DIR: './knowledge', LOG_LEVEL: 'info' };
  assert.equal(loadConfig(old).LOG_LEVEL, 'info');
  const warnings: string[] = [];
  const { specs } = buildLlm(old, undefined, (m) => { warnings.push(m); });
  assert.deepEqual(specs, [{ provider: 'groq', model: 'qwen/qwen3.8-27b' }]);
  assert.match(warnings[0] ?? '', /LLM_PRIMARY is not set/u);
  assert.equal(buildEmbedder(old), undefined, 'no embeddings key = keyword-only search, not a crash');
});

test('blank optional values never stop startup; invalid values are reported by name', () => {
  assert.doesNotThrow(() => loadConfig({ GROQ_API_KEY: '', MISTRAL_API_KEY: '  ', OPENROUTER_API_KEY: '', LLM_PRIMARY: '' }));
  assert.throws(() => loadConfig({ LOG_LEVEL: 'loud' }), /LOG_LEVEL/u);
  assert.throws(() => loadConfig({ VALIDATION_MODE: 'strict' }), /VALIDATION_MODE/u);
});

test('documentation matches the code: every environment variable the program reads is in .env.example and SETUP.md, and nothing documented is unknown to the code', async () => {
  const files = [...await sourceFiles('src'), ...await sourceFiles('eval')];
  const code = (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
  const read = new Set<string>();
  for (const m of code.matchAll(/\b(?:process\.env|env)\.([A-Z][A-Z0-9_]+)/gu)) read.add(m[1]!);
  for (const m of code.matchAll(/keyEnv:\s*'([A-Z0-9_]+)'/gu)) read.add(m[1]!);
  const presets = await readFile('src/llm/presets.ts', 'utf8');
  for (const m of presets.matchAll(/\{([A-Z][A-Z0-9_]+)\}/gu)) read.add(m[1]!);
  for (const m of (await readFile('src/config/env.ts', 'utf8')).matchAll(/^\s{2}([A-Z][A-Z0-9_]+): z\./gmu)) read.add(m[1]!);
  for (const provider of ['MISTRAL', 'GEMINI', 'GROQ', 'OPENROUTER']) read.add(`LLM_LIMITS_${provider}`);
  const example = await readFile('.env.example', 'utf8');
  const setup = await readFile('SETUP.md', 'utf8');
  for (const name of read) {
    assert.ok(new RegExp(`\\b${name}\\b`, 'u').test(example), `${name} is read by the code but missing from .env.example`);
    assert.ok(new RegExp(`\\b${name}\\b`, 'u').test(setup) || /^(LLM_LIMITS_|LLM_TIMEOUT_MS|GROQ_REASONING_EFFORT|EMBEDDING_MODEL)/u.test(name), `${name} is read by the code but missing from SETUP.md`);
  }
  for (const name of Object.keys(parseEnvFile(example.replace(/^#\s*([A-Z][A-Z0-9_]+=)/gmu, '$1')))) assert.ok(read.has(name), `${name} is in .env.example but nothing in the code reads it`);
  assert.equal(read.has('ASSISTANT_CHANNEL_ID'), false, 'ASSISTANT_CHANNEL_ID was never used by the code and must stay removed');
});
