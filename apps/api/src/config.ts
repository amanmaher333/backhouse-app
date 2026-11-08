import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv({ path: new URL('../../../.env', import.meta.url) });

const schema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_ACCESS_SECRET: z.string().min(8),
  JWT_REFRESH_SECRET: z.string().min(8),
  JWT_ACCESS_TTL: z.string().default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(30),
  INVITE_TTL_DAYS: z.coerce.number().int().positive().default(7),
  PORT: z.coerce.number().int().default(3000),
  NODE_ENV: z.string().default('development'),
  /** 'claude' uses the Anthropic API (needs ANTHROPIC_API_KEY); 'template' never calls a model. Default: claude when a key is set. */
  AGENTS_LLM: z.enum(['claude', 'template']).optional(),
  AGENTS_MODEL: z.string().default('claude-opus-5-5'),
  ANTHROPIC_API_KEY: z.string().optional(),
  WORKER_POLL_MS: z.coerce.number().int().min(200).default(5000),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof AppConfig, string>> = {}): AppConfig {
  return schema.parse({ ...process.env, ...overrides });
}

export const APP_CONFIG = Symbol('APP_CONFIG');
