import { loadConfig } from './config/env.js';
import { openDatabase } from './database/database.js';
import { loadKnowledge } from './knowledge/retrieval.js';
import { logger } from './logging/logger.js';
import { requireDiscordConfig, requireGeminiConfig } from './config/env.js';
import { GuildSettingsRepository, MessageRepository, TicketRepository } from './database/repositories.js';
import { GeminiProvider } from './gemini/client.js';
import { AssistantService } from './assistant/service.js';
import { createDiscordClient } from './discord/client.js';
import { registerCommands } from './discord/commands.js';

async function main() {
  const config = loadConfig();
  logger.configure(config.LOG_LEVEL);
  const db = await openDatabase(config.DATABASE_PATH);
  const chunks = await loadKnowledge(config.KNOWLEDGE_DIR);
  logger.info('Startup health check passed', { knowledgeChunks: chunks.length, database: 'ready' });
  const discord = requireDiscordConfig(config);
  const gemini = requireGeminiConfig(config);
  const provider = new GeminiProvider(gemini.apiKey, gemini.model);
  const assistant = new AssistantService(provider, new MessageRepository(db), chunks);
  const client = createDiscordClient(assistant, new GuildSettingsRepository(db), new TicketRepository(db));
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
