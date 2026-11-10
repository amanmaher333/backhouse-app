import { Decimal } from 'decimal.js';
import { normalizeName } from './text.js';

/*
 * Kitchain subscriptions. Restaurants pay a platform fee per organisation plus each hired agent
 * per active site; suppliers are free. Annual billing is ten months' price for twelve.
 * All prices in SAR, before 15% VAT. These are launch prices to validate with design partners.
 */

export type BillingInterval = 'month' | 'year';

export const PLATFORM_FEE_MONTHLY = '400.00';
/** Per agent kind, per active site, per month. Unknown kinds use the default. */
export const AGENT_SITE_FEES_MONTHLY: Record<string, string> = { price_watch: '150.00', purchasing: '350.00' };
export const DEFAULT_AGENT_SITE_FEE = '250.00';
export const TRIAL_DAYS = 30;
export const ANNUAL_MONTHS_CHARGED = 10;
export const BILLING_VAT_RATE = '0.15';

export interface BillLine {
  code: string;
  description: string;
  descriptionAr: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}

export interface Bill {
  interval: BillingInterval;
  lines: BillLine[];
  subtotal: string;
  vat: string;
  total: string;
}

export interface BillInput {
  interval: BillingInterval;
  /** Active sites (at least one is billed). */
  activeSites: number;
  /** Hired, active agents by kind, with display names. */
  agents: { kind: string; name: string; nameAr: string }[];
  /** Custom pricing agreed with this organisation (design partners, pilots). */
  pricing?: CustomPricing | null;
  /** The date the bill is for (YYYY-MM-DD); custom pricing past its `until` date no longer applies. */
  asOf?: string;
}

/**
 * Prices agreed with one organisation, set by Kitchain staff. Anything left out uses the list price.
 * After `until` (inclusive), list prices apply again.
 */
export interface CustomPricing {
  /** Shown to the customer, e.g. "Design partner". */
  label: string;
  labelAr?: string | null;
  /** Monthly platform fee before VAT, e.g. "0.00" or "200.00". */
  platformFee?: string | null;
  /** Monthly price per site by agent kind, before VAT. */
  agentFees?: Record<string, string> | null;
  /** Percentage off the whole bill (after the prices above), 0–100. */
  discountPct?: number | null;
  /** Last day the pricing applies (YYYY-MM-DD); empty = no end date. */
  until?: string | null;
  /** Internal note for Kitchain staff (not shown to the customer). */
  note?: string | null;
}

/** Whether custom pricing applies on a given date. */
export function pricingActive(p: CustomPricing | null | undefined, asOf: string): p is CustomPricing {
  return Boolean(p && (!p.until || asOf <= p.until));
}

/** What the next period costs, line by line. Amounts rounded to halalas. */
export function computeBill(input: BillInput): Bill {
  const months = input.interval === 'year' ? ANNUAL_MONTHS_CHARGED : 1;
  const per = input.interval === 'year' ? { en: 'year', ar: 'سنة' } : { en: 'month', ar: 'شهر' };
  const sites = Math.max(1, input.activeSites);
  const lines: BillLine[] = [];
  const add = (code: string, en: string, ar: string, qty: number, monthly: string) => {
    const unit = new Decimal(monthly).mul(months);
    lines.push({ code, description: en, descriptionAr: ar, quantity: qty, unitPrice: unit.toFixed(2), amount: unit.mul(qty).toFixed(2) });
  };
  const custom = pricingActive(input.pricing, input.asOf ?? new Date().toISOString().slice(0, 10)) ? input.pricing : null;
  add('platform', `Kitchain platform (1 ${per.en})`, `منصة Kitchain (${per.ar} واحد)`, 1, custom?.platformFee ?? PLATFORM_FEE_MONTHLY);
  for (const a of input.agents) {
    add(
      `agent:${a.kind}`,
      `${a.name} agent × ${sites} ${sites === 1 ? 'site' : 'sites'} (1 ${per.en})`,
      `وكيل ${a.nameAr} × ${sites} ${sites === 1 ? 'فرع' : 'فروع'} (${per.ar} واحد)`,
      sites,
      custom?.agentFees?.[a.kind] ?? AGENT_SITE_FEES_MONTHLY[a.kind] ?? DEFAULT_AGENT_SITE_FEE,
    );
  }
  const pct = Math.min(100, Math.max(0, Number(custom?.discountPct ?? 0)));
  if (custom && pct > 0) {
    const before = lines.reduce((s, l) => s.add(l.amount), new Decimal(0));
    const off = before.mul(pct).div(100).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).neg();
    const name = custom.label.trim() || 'Agreed';
    const nameAr = custom.labelAr?.trim() || name;
    lines.push({ code: 'discount', description: `${name} discount (${pct}%)`, descriptionAr: `خصم ${nameAr} (${pct}٪)`, quantity: 1, unitPrice: off.toFixed(2), amount: off.toFixed(2) });
  }
  const subtotal = lines.reduce((s, l) => s.add(l.amount), new Decimal(0));
  const vat = subtotal.mul(BILLING_VAT_RATE).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  return { interval: input.interval, lines, subtotal: subtotal.toFixed(2), vat: vat.toFixed(2), total: subtotal.add(vat).toFixed(2) };
}

/** Period end: one calendar month or year after the start (end of month is clamped, e.g. 31 Jan → 28/29 Feb). */
export function addInterval(start: Date, interval: BillingInterval): Date {
  const d = new Date(start.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  if (interval === 'year') d.setUTCFullYear(d.getUTCFullYear() + 1);
  else d.setUTCMonth(d.getUTCMonth() + 1);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** Halalas (the smallest SAR unit) for payment providers. */
export const toHalalas = (sar: string) => new Decimal(sar).mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toNumber();

/**
 * ZATCA e-invoice QR (phase 1, "generation"): TLV-encoded seller name, VAT number,
 * timestamp, invoice total and VAT total, base64. Phase 2 (integration/clearance) adds
 * signed XML and more tags; that comes with the ZATCA integration.
 */
export function zatcaQr(f: { sellerName: string; vatNumber: string; timestamp: Date | string; total: string; vatTotal: string }): string {
  const enc = new TextEncoder();
  const parts = [f.sellerName, f.vatNumber, typeof f.timestamp === 'string' ? f.timestamp : f.timestamp.toISOString(), f.total, f.vatTotal];
  const bytes: number[] = [];
  parts.forEach((value, i) => {
    const v = enc.encode(value);
    if (v.length > 255) throw new Error(`QR field ${i + 1} is too long`);
    bytes.push(i + 1, v.length, ...v);
  });
  return btoa(String.fromCharCode(...bytes));
}

/** Decodes a ZATCA phase-1 QR (for tests and invoice checks). */
export function decodeZatcaQr(b64: string): string[] {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const out: string[] = [];
  for (let i = 0; i < bin.length; ) {
    const len = bin[i + 1]!;
    out.push(new TextDecoder().decode(bin.slice(i + 2, i + 2 + len)));
    i += 2 + len;
  }
  return out;
}

const LEGAL_WORDS = new Set([
  'شركه', 'شركة', 'مؤسسه', 'مؤسسة', 'ذات', 'مسؤوليه', 'مسؤولية', 'محدوده', 'محدودة', 'شخص', 'واحد', 'مساهمه', 'مساهمة', 'مقفله', 'مقفلة', 'للتجاره', 'للتجارة', 'التجاريه', 'التجارية', 'و',
  'company', 'co', 'llc', 'ltd', 'limited', 'est', 'establishment', 'trading', 'group', 'the', 'and', 'for', 'of', 'inc', 'jsc', 'cjsc', 'sole', 'proprietorship',
]);

const tokens = (s: string) =>
  new Set(
    normalizeName(s)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .map((t) => t.replace(/^ال(?=\S{3,})/, ''))
      .filter((t) => t && !LEGAL_WORDS.has(t)),
  );

/**
 * How well a name entered at sign-up matches the name in the commercial register, 0–1.
 * Ignores legal forms ("شركة", "LLC", "Est.") and the Arabic article; compares word sets.
 */
export function companyNameSimilarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (!x.size || !y.size) return 0;
  let common = 0;
  for (const t of x) if (y.has(t)) common++;
  return common / Math.min(x.size, y.size);
}

/** How many days before the trial ends the reminder goes out. */
export const TRIAL_REMINDER_DAYS = 3;

/**
 * Whether the "trial ends soon" reminder is due: within TRIAL_REMINDER_DAYS of the end, from the
 * person's chosen local hour; in the last 24 hours at any hour, so it is never missed.
 */
export function trialReminderDue(now: Date, trialEndsAt: Date, timeZone: string, hour: number): boolean {
  const left = trialEndsAt.getTime() - now.getTime();
  if (left <= 0 || left > TRIAL_REMINDER_DAYS * 86400_000) return false;
  if (left <= 86400_000) return true;
  const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hourCycle: 'h23' }).format(now));
  return h >= hour;
}
