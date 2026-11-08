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
  /** Where people open BOH; used in links inside WhatsApp messages. */
  PUBLIC_WEB_URL: z.string().url().default('http://localhost:3001'),
  /**
   * WhatsApp Business Cloud API. 'cloud' sends through Meta (needs token, phone number id, app secret).
   * 'simulated' (default without a token) stores messages and lets the web app play the person's phone.
   */
  WHATSAPP_MODE: z.enum(['cloud', 'simulated']).optional(),
  WHATSAPP_TOKEN: z.string().optional(),
  WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
  /** Meta app secret: verifies the X-Hub-Signature-256 header on webhooks. */
  WHATSAPP_APP_SECRET: z.string().optional(),
  /** Token you choose when subscribing the webhook in Meta's dashboard. */
  WHATSAPP_VERIFY_TOKEN: z.string().optional(),
  WHATSAPP_GRAPH_VERSION: z.string().default('v25.0'),
  /** BOH's WhatsApp number in E.164, shown to people for linking (wa.me link). */
  WHATSAPP_BUSINESS_NUMBER: z.string().default('+966500000000'),
  WHATSAPP_TEMPLATE_APPROVAL: z.string().default('boh_approval_request'),
  WHATSAPP_TEMPLATE_NOTICE: z.string().default('boh_task_notice'),
  WHATSAPP_TEMPLATE_DIGEST: z.string().default('boh_daily_digest'),
  /** Approval cards stop working after this many hours (the task stays in the inbox). */
  WHATSAPP_PROMPT_TTL_HOURS: z.coerce.number().int().positive().default(72),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(overrides: Partial<Record<keyof AppConfig, string>> = {}): AppConfig {
  return schema.parse({ ...process.env, ...overrides });
}

export const APP_CONFIG = Symbol('APP_CONFIG');
