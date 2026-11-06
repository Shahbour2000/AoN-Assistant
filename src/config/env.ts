import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1).optional(),
  DISCORD_CLIENT_ID: z.string().trim().min(1).optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_MODEL: z.string().default('gemini-2.5-flash'),
  ASSISTANT_CHANNEL_ID: z.string().trim().min(1).optional(),
  DATABASE_PATH: z.string().default('./data/aon-assistant.sqlite'),
  KNOWLEDGE_DIR: z.string().default('./knowledge'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export function loadConfig() {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const invalid = result.error.issues.map((issue) => issue.path.join('.')).join(', ');
    throw new Error(`Invalid environment configuration. Check: ${invalid}`);
  }
  return result.data;
}

export function requireDiscordConfig(config: ReturnType<typeof loadConfig>) {
  if (!config.DISCORD_TOKEN || !config.DISCORD_CLIENT_ID) throw new Error('Discord configuration is required for Discord features.');
  return { token: config.DISCORD_TOKEN, clientId: config.DISCORD_CLIENT_ID };
}

export function requireGeminiConfig(config: ReturnType<typeof loadConfig>) {
  if (!config.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required for Gemini features.');
  return { apiKey: config.GEMINI_API_KEY, model: config.GEMINI_MODEL };
}
