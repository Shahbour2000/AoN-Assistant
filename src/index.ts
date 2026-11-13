import { loadConfig } from './config/env.js';
import { openDatabase } from './database/database.js';
import { loadKnowledge } from './knowledge/retrieval.js';
import { logger } from './logging/logger.js';
import { requireDiscordConfig, requireGroqConfig } from './config/env.js';
import { GuildSettingsRepository, LinkedPlayerRepository, MessageRepository, TicketRepository } from './database/repositories.js';
import { GroqProvider } from './groq/client.js';
import { AssistantService } from './assistant/service.js';
import { createDiscordClient } from './discord/client.js';
import { registerCommands } from './discord/commands.js';
import { AonApiClient } from './aon-api/client.js';
import { PlayerLinkService } from './aon-api/linking.js';
import { readFile } from 'node:fs/promises';
import { apiReferenceChunks } from './knowledge/api-reference.js';
import type { KnowledgeChunk } from './knowledge/retrieval.js';

async function main() {
  const config = loadConfig();
  logger.configure(config.LOG_LEVEL);
  const db = await openDatabase(config.DATABASE_PATH);
  const chunks = await loadKnowledge(config.KNOWLEDGE_DIR);
  let apiChunks: KnowledgeChunk[] = [];
  try { apiChunks = apiReferenceChunks(JSON.parse(await readFile(`${config.KNOWLEDGE_DIR}/AgeOfNations_API_Reference.json`, 'utf8')) as unknown); }
  catch (error) { logger.warn('Age of Nations API reference unavailable to knowledge search', { error: error instanceof Error ? error.message : 'invalid reference' }); }
  chunks.push(...apiChunks);
  logger.info('Startup health check passed', { knowledgeChunks: chunks.length, database: 'ready' });
  const discord = requireDiscordConfig(config);
  const groq = requireGroqConfig(config);
  const provider = new GroqProvider(groq.apiKey, groq.model);
  const linkedPlayers = new LinkedPlayerRepository(db);
  const aonApi = new AonApiClient();
  const assistant = new AssistantService(provider, new MessageRepository(db), chunks, { links: linkedPlayers, api: aonApi });
  const client = createDiscordClient(assistant, new GuildSettingsRepository(db), new TicketRepository(db), { api: aonApi, links: linkedPlayers, linking: new PlayerLinkService(aonApi, linkedPlayers) });
  await registerCommands(discord.token, discord.clientId);
  await client.login(discord.token);
  const shutdown = async () => {
    await client.destroy();
    db.close();
  };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
}

main().catch((error: unknown) => {
  logger.error('Startup health check failed', { error: error instanceof Error ? error.message : 'Unknown error' });
  process.exitCode = 1;
});
