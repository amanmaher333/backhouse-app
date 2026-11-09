import { randomUUID } from 'node:crypto';
import { waId } from '@boh/domain';
import type { AppConfig } from '../config.js';

/** What Backhouse stores for each outbound message; the sender turns it into a Cloud API request. */
export interface MessageContent {
  lang: 'ar' | 'en';
  /** Free-form body (text message, or interactive body). */
  text: string;
  footer?: string;
  /** Reply buttons (max 3) for interactive messages inside the 24-hour window. */
  buttons?: { id: string; title: string }[];
  /** Used outside the 24-hour window. Without it, a message that falls outside the window fails. */
  template?: { name: string; bodyParams: string[]; quickReplyPayloads: string[]; urlSuffix?: string; urlButtonIndex?: number };
}

export type SendForm = 'text' | 'interactive' | 'template';

export class SendError extends Error {
  constructor(
    message: string,
    /** True when retrying might work (network, rate limit, 5xx). */
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export interface WhatsAppTransport {
  readonly mode: 'cloud' | 'simulated';
  send(toE164: string, content: MessageContent, form: SendForm): Promise<{ providerMessageId: string }>;
}

/** Builds the Graph API request body. Exported for tests. */
export function cloudRequestBody(toE164: string, content: MessageContent, form: SendForm): Record<string, unknown> {
  const base = { messaging_product: 'whatsapp', recipient_type: 'individual', to: waId(toE164) };
  if (form === 'text') return { ...base, type: 'text', text: { body: content.text, preview_url: false } };
  if (form === 'interactive') {
    return {
      ...base,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: content.text },
        ...(content.footer ? { footer: { text: content.footer } } : {}),
        action: { buttons: (content.buttons ?? []).map((b) => ({ type: 'reply', reply: { id: b.id, title: b.title } })) },
      },
    };
  }
  const t = content.template!;
  const components: Record<string, unknown>[] = [{ type: 'body', parameters: t.bodyParams.map((text) => ({ type: 'text', text })) }];
  t.quickReplyPayloads.forEach((payload, index) =>
    components.push({ type: 'button', sub_type: 'quick_reply', index: String(index), parameters: [{ type: 'payload', payload }] }),
  );
  if (t.urlSuffix !== undefined) {
    components.push({ type: 'button', sub_type: 'url', index: String(t.urlButtonIndex ?? t.quickReplyPayloads.length), parameters: [{ type: 'text', text: t.urlSuffix }] });
  }
  return { ...base, type: 'template', template: { name: t.name, language: { code: content.lang }, components } };
}

/** Meta's WhatsApp Business Cloud API. */
export class CloudApiTransport implements WhatsAppTransport {
  readonly mode = 'cloud' as const;

  constructor(private readonly config: AppConfig) {}

  async send(toE164: string, content: MessageContent, form: SendForm) {
    const url = `https://graph.facebook.com/${this.config.WHATSAPP_GRAPH_VERSION}/${this.config.WHATSAPP_PHONE_NUMBER_ID}/messages`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.config.WHATSAPP_TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify(cloudRequestBody(toE164, content, form)),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      throw new SendError(`network: ${(err as Error).message}`, true);
    }
    const body = (await res.json().catch(() => ({}))) as { messages?: { id: string }[]; error?: { message?: string; code?: number } };
    if (!res.ok || !body.messages?.[0]?.id) {
      const msg = `${res.status} ${body.error?.code ?? ''} ${body.error?.message ?? 'no message id'}`.trim();
      // 429, 5xx and Meta's throttling codes are worth retrying; 4xx (bad template, invalid number) are not.
      const retryable = res.status === 429 || res.status >= 500 || [4, 80007, 130429, 131016, 131048, 131056].includes(body.error?.code ?? -1);
      throw new SendError(msg, retryable);
    }
    return { providerMessageId: body.messages[0].id };
  }
}

/** Development and tests: nothing leaves the machine; messages are visible in the web simulator. */
export class SimulatedTransport implements WhatsAppTransport {
  readonly mode = 'simulated' as const;
  readonly sent: { to: string; content: MessageContent; form: SendForm; id: string }[] = [];

  async send(toE164: string, content: MessageContent, form: SendForm) {
    const id = `sim.${randomUUID()}`;
    this.sent.push({ to: toE164, content, form, id });
    if (this.sent.length > 500) this.sent.shift();
    return { providerMessageId: id };
  }
}

export const WHATSAPP_TRANSPORT = Symbol('WHATSAPP_TRANSPORT');

export function createTransport(config: AppConfig): WhatsAppTransport {
  const mode = config.WHATSAPP_MODE ?? (config.WHATSAPP_TOKEN ? 'cloud' : 'simulated');
  if (mode === 'cloud') {
    if (!config.WHATSAPP_TOKEN || !config.WHATSAPP_PHONE_NUMBER_ID || !config.WHATSAPP_APP_SECRET) {
      throw new Error('WHATSAPP_MODE=cloud needs WHATSAPP_TOKEN, WHATSAPP_PHONE_NUMBER_ID and WHATSAPP_APP_SECRET');
    }
    return new CloudApiTransport(config);
  }
  return new SimulatedTransport();
}
