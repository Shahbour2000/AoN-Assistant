import path from 'node:path';
import { loadConfig, requireDiscordConfig } from './config/env.js';
import { openDatabase } from './database/database.js';
import { KnowledgeBase } from './knowledge/index.js';
import { logger } from './logging/logger.js';
import { GuildSettingsRepository, LinkedPlayerRepository, MessageRepository, TicketRepository } from './database/repositories.js';
import { AssistantService } from './assistant/service.js';
import { createDiscordClient } from './discord/client.js';
import { registerCommands } from './discord/commands.js';
import { AonApiClient } from './aon-api/client.js';
import { PlayerLinkService } from './aon-api/linking.js';
import { buildEmbedder, buildLlm } from './llm/presets.js';

async function main() {
  const config = loadConfig();
  logger.configure(config.LOG_LEVEL);
  const db = await openDatabase(config.DATABASE_PATH);
  const { llm, specs } = buildLlm(process.env, undefined, (message) => logger.warn(message));
  const embedder = buildEmbedder(process.env);
  const knowledge = await KnowledgeBase.create({ dir: config.KNOWLEDGE_DIR, embedder, cacheFile: path.join(path.dirname(config.DATABASE_PATH), 'embeddings.json') });
  logger.info('Startup health check passed', { knowledgeChunks: knowledge.chunkCount, knowledgeMode: knowledge.semanticReady ? 'hybrid' : 'keyword', llm: specs.map((spec) => `${spec.provider}:${spec.model}`), embedder: embedder?.id ?? 'none', database: 'ready' });
  const discord = requireDiscordConfig(config);
  const linkedPlayers = new LinkedPlayerRepository(db);
  const aonApi = new AonApiClient();
  const messages = new MessageRepository(db);
  const assistant = new AssistantService({ llm, messages, knowledge, api: aonApi, links: linkedPlayers, validation: config.VALIDATION_MODE });
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
