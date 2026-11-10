import { randomUUID } from 'node:crypto';
import type { AppConfig } from '../config.js';

export interface CardDetails {
  brand: string;
  last4: string;
  expMonth?: number;
  expYear?: number;
}

export type ChargeResult =
  | { status: 'paid'; paymentId: string }
  | { status: 'failed'; paymentId: string | null; message: string; retryable: boolean }
  /** The bank wants the cardholder to confirm (3-D Secure). Only possible when they are present. */
  | { status: 'requires_action'; paymentId: string; actionUrl: string }
  /** Bank transfer agreed with Kitchain: the invoice waits for the money (service continues until the due date and grace). */
  | { status: 'awaiting_transfer'; dueAt: Date };

export interface WebhookEvent {
  id: string;
  type: 'payment_paid' | 'payment_failed' | string;
  paymentId: string;
  message?: string;
}

export interface PaymentProvider {
  readonly name: 'simulated' | 'moyasar';
  /** Checks a card token made by the provider's payment form and returns what to show. */
  describeToken(token: string): Promise<CardDetails>;
  charge(p: { amountHalalas: number; token: string; description: string; invoiceId: string; callbackUrl: string }): Promise<ChargeResult>;
  /** Verifies and parses a webhook body; null if it is not authentic. */
  parseWebhook(body: any): WebhookEvent | null;
}

/**
 * Test cards. Tokens look like "tok_sim_<brand>_<last4>", with optional suffixes:
 * "_decline" (always declined) and "_3ds" (needs the cardholder to confirm).
 */
export class SimulatedPayments implements PaymentProvider {
  readonly name = 'simulated' as const;
  readonly pending = new Map<string, { invoiceId: string }>();

  async describeToken(token: string): Promise<CardDetails> {
    const m = /^tok_sim_(visa|mastercard|mada|amex)_(\d{4})(?:_(decline|3ds))?$/.exec(token);
    if (!m) throw new Error('Invalid card token');
    return { brand: m[1]!, last4: m[2]!, expMonth: 12, expYear: 2030 };
  }

  async charge(p: { amountHalalas: number; token: string; invoiceId: string; callbackUrl: string }): Promise<ChargeResult> {
    await this.describeToken(p.token);
    const paymentId = `sim_pay_${randomUUID()}`;
    if (p.token.endsWith('_decline')) return { status: 'failed', paymentId, message: 'Card declined by the bank', retryable: true };
    if (p.token.endsWith('_3ds')) {
      this.pending.set(paymentId, { invoiceId: p.invoiceId });
      return { status: 'requires_action', paymentId, actionUrl: `${p.callbackUrl}${p.callbackUrl.includes('?') ? '&' : '?'}sim_payment=${paymentId}` };
    }
    return { status: 'paid', paymentId };
  }

  parseWebhook(body: any): WebhookEvent | null {
    if (body?.secret_token !== 'simulated' || !body?.id || !body?.data?.id) return null;
    return { id: String(body.id), type: String(body.type), paymentId: String(body.data.id), message: body.data?.source?.message };
  }
}

/**
 * Moyasar (Saudi payment gateway: mada, Visa, Mastercard, Apple Pay, STC Pay).
 * Field names follow Moyasar's public API as we know it; check them against
 * docs.moyasar.com before going live (the docs could not be reached from this environment).
 */
export class MoyasarPayments implements PaymentProvider {
  readonly name = 'moyasar' as const;
  private readonly base = 'https://api.moyasar.com/v1';

  constructor(private readonly config: AppConfig) {}

  private get auth() {
    return `Basic ${Buffer.from(`${this.config.MOYASAR_SECRET_KEY}:`).toString('base64')}`;
  }

  async describeToken(token: string): Promise<CardDetails> {
    const r = await fetch(`${this.base}/tokens/${encodeURIComponent(token)}`, { headers: { authorization: this.auth }, signal: AbortSignal.timeout(15_000) });
    const b = (await r.json().catch(() => ({}))) as { brand?: string; last_four?: string; month?: string; year?: string; status?: string; message?: string };
    if (!r.ok || !b.last_four) throw new Error(b.message ?? 'Invalid card token');
    return { brand: b.brand ?? 'card', last4: b.last_four, expMonth: b.month ? Number(b.month) : undefined, expYear: b.year ? Number(b.year) : undefined };
  }

  async charge(p: { amountHalalas: number; token: string; description: string; invoiceId: string; callbackUrl: string }): Promise<ChargeResult> {
    let r: Response;
    try {
      r = await fetch(`${this.base}/payments`, {
        method: 'POST',
        headers: { authorization: this.auth, 'content-type': 'application/json' },
        body: JSON.stringify({
          amount: p.amountHalalas,
          currency: 'SAR',
          description: p.description,
          callback_url: p.callbackUrl,
          source: { type: 'token', token: p.token },
          metadata: { invoice_id: p.invoiceId },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      return { status: 'failed', paymentId: null, message: `Payment service unreachable: ${(err as Error).message}`, retryable: true };
    }
    const b = (await r.json().catch(() => ({}))) as { id?: string; status?: string; message?: string; source?: { transaction_url?: string; message?: string } };
    if (b.status === 'paid' && b.id) return { status: 'paid', paymentId: b.id };
    if (b.status === 'initiated' && b.id && b.source?.transaction_url) return { status: 'requires_action', paymentId: b.id, actionUrl: b.source.transaction_url };
    return { status: 'failed', paymentId: b.id ?? null, message: b.source?.message ?? b.message ?? `Payment failed (${r.status})`, retryable: r.status >= 500 || r.status === 429 };
  }

  parseWebhook(body: any): WebhookEvent | null {
    const secret = this.config.MOYASAR_WEBHOOK_SECRET;
    if (!secret || body?.secret_token !== secret || !body?.id || !body?.data?.id) return null;
    return { id: String(body.id), type: String(body.type), paymentId: String(body.data.id), message: body.data?.source?.message };
  }
}

export const PAYMENT_PROVIDER = Symbol('PAYMENT_PROVIDER');

export function createPaymentProvider(config: AppConfig): PaymentProvider {
  if (config.BILLING_PROVIDER === 'moyasar') {
    if (!config.MOYASAR_SECRET_KEY || !config.MOYASAR_WEBHOOK_SECRET) throw new Error('BILLING_PROVIDER=moyasar needs MOYASAR_SECRET_KEY and MOYASAR_WEBHOOK_SECRET');
    return new MoyasarPayments(config);
  }
  return new SimulatedPayments();
}
