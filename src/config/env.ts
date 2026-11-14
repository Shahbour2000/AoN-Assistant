import 'dotenv/config';
import { z } from 'zod';

const schema = z.object({
  DISCORD_TOKEN: z.string().trim().min(1).optional(),
  DISCORD_CLIENT_ID: z.string().trim().min(1).optional(),
  // LLM providers: see .env.example. At least LLM_PRIMARY (or the legacy GROQ_API_KEY) must resolve to a usable provider at startup.
  LLM_PRIMARY: z.string().trim().min(1).optional(),
  LLM_BACKUP: z.string().trim().optional(),
  GROQ_API_KEY: z.string().trim().min(1).optional(),
  GROQ_MODEL: z.string().trim().min(1).optional(),
  MISTRAL_API_KEY: z.string().trim().min(1).optional(),
  GEMINI_API_KEY: z.string().trim().min(1).optional(),
  OPENROUTER_API_KEY: z.string().trim().min(1).optional(),
  EMBEDDING_PROVIDER: z.string().trim().optional(),
  VALIDATION_MODE: z.enum(['off', 'basic', 'llm']).default('basic'),
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
