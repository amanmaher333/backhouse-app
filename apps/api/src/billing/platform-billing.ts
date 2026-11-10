import { BadRequestException, Body, Controller, Get, HttpCode, Injectable, NotFoundException, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { agents, billingInvoices, organizations, sites, subscriptions } from '@boh/db';
import { BillingService } from './billing.service.js';
import { computeBill, pricingActive, type CustomPricing } from '@boh/domain';
import { CurrentAuth } from '../common/auth.js';
import { DbService } from '../common/db.service.js';
import { auditRaw } from '../common/audit.js';
import { VerificationService } from '../verification/verification.js';

const money = z.union([z.number(), z.string()]).transform((v) => Number(v)).refine((v) => Number.isFinite(v) && v >= 0 && v <= 1_000_000, 'Enter an amount from 0').transform((v) => v.toFixed(2));
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const PricingSchema = z.object({
  label: z.string().trim().min(1).max(60),
  labelAr: z.string().trim().max(60).nullish(),
  platformFee: money.nullish(),
  agentFees: z.record(z.string().max(40), money).nullish(),
  discountPct: z.number().min(0).max(100).nullish(),
  until: date.nullish(),
  note: z.string().max(500).nullish(),
});
class PricingDto extends createZodDto(z.object({ pricing: PricingSchema.nullable() })) {}
class TrialDto extends createZodDto(z.object({ trialEndsOn: date })) {}
class ModeDto extends createZodDto(z.object({ mode: z.enum(['card', 'bank_transfer']) })) {}
class PaidDto extends createZodDto(z.object({ reference: z.string().trim().min(1).max(120) })) {}
class ListDto extends createZodDto(z.object({ q: z.string().max(100).optional() })) {}

/**
 * Kitchain staff: per-organisation pricing (design partners, pilots) and trial extensions.
 * Only members of Kitchain's own organisation (type "platform") can use these.
 */
@Injectable()
export class PlatformBillingService {
  constructor(
    private readonly db: DbService,
    private readonly verification: VerificationService,
    private readonly billing: BillingService,
  ) {}

  async list(userId: string, q?: string, onlyId?: string) {
    await this.verification.assertPlatformAdmin(userId);
    return this.db.system(async (tx) => {
      const rows = await tx
        .select({ org: organizations, sub: subscriptions })
        .from(organizations)
        .innerJoin(subscriptions, eq(subscriptions.orgId, organizations.id))
        .where(and(ne(organizations.type, 'platform'), eq(subscriptions.plan, 'restaurant'), onlyId ? eq(organizations.id, onlyId) : undefined, q ? sql`(${organizations.name} ilike ${'%' + q + '%'} or ${organizations.nameAr} ilike ${'%' + q + '%'})` : undefined))
        .orderBy(asc(organizations.name))
        .limit(200);
      const today = new Date().toISOString().slice(0, 10);
      const out = [];
      for (const { org, sub } of rows) {
        const [n] = await tx.select({ n: sql<number>`count(*)::int` }).from(sites).where(and(eq(sites.orgId, org.id), eq(sites.isActive, true)));
        const hired = await tx.select({ kind: agents.kind, name: agents.name, nameAr: agents.nameAr }).from(agents).where(and(eq(agents.orgId, org.id), eq(agents.status, 'active')));
        const input = { interval: 'month' as const, activeSites: n?.n ?? 0, agents: hired.map((h) => ({ kind: h.kind, name: h.name, nameAr: h.nameAr ?? h.name })), asOf: today };
        const pricing = (sub.pricing as CustomPricing | null) ?? null;
        out.push({
          id: org.id,
          name: org.name,
          nameAr: org.nameAr,
          country: org.country,
          createdAt: org.createdAt,
          status: sub.status,
          interval: sub.interval,
          trialEndsAt: sub.trialEndsAt,
          currentPeriodEnd: sub.currentPeriodEnd,
          activeSites: n?.n ?? 0,
          agents: hired.map((h) => h.kind),
          pricing,
          pricingActive: pricingActive(pricing, today),
          paymentMode: sub.paymentMode,
          // Invoices waiting for a bank transfer (or failed), newest first: what staff may need to mark paid.
          unpaid: await tx
            .select({ id: billingInvoices.id, number: billingInvoices.number, total: billingInvoices.total, status: billingInvoices.status, dueAt: billingInvoices.dueAt, issuedAt: billingInvoices.issuedAt })
            .from(billingInvoices)
            .where(and(eq(billingInvoices.orgId, org.id), inArray(billingInvoices.status, ['awaiting_transfer', 'failed', 'open'])))
            .orderBy(desc(billingInvoices.issuedAt)),
          monthly: { list: computeBill(input).total, agreed: computeBill({ ...input, pricing }).total },
        });
      }
      return out;
    });
  }

  async setPricing(userId: string, orgId: string, pricing: CustomPricing | null) {
    await this.verification.assertPlatformAdmin(userId);
    await this.db.system(async (tx) => {
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).for('update');
      if (!s) throw new NotFoundException('Organisation not found');
      const clean = pricing ? (Object.fromEntries(Object.entries(pricing).filter(([, v]) => v !== null && v !== undefined && v !== '')) as unknown as CustomPricing) : null;
      await tx.update(subscriptions).set({ pricing: clean as unknown as Record<string, unknown> | null }).where(eq(subscriptions.orgId, orgId));
      await auditRaw(tx, { orgId, userId, requestId: 'platform', action: clean ? 'billing.pricing_set' : 'billing.pricing_cleared', entityType: 'subscription', entityId: orgId, before: { pricing: s.pricing }, after: { pricing: clean } });
    });
    return (await this.list(userId, undefined, orgId))[0] ?? null;
  }

  /** Card (default) or bank transfer. With bank transfer no card is needed and invoices wait for the money. */
  async setPaymentMode(userId: string, orgId: string, mode: 'card' | 'bank_transfer') {
    await this.verification.assertPlatformAdmin(userId);
    await this.db.system(async (tx) => {
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).for('update');
      if (!s) throw new NotFoundException('Organisation not found');
      await tx.update(subscriptions).set({ paymentMode: mode }).where(eq(subscriptions.orgId, orgId));
      await auditRaw(tx, { orgId, userId, requestId: 'platform', action: 'billing.payment_mode_set', entityType: 'subscription', entityId: orgId, before: { paymentMode: s.paymentMode }, after: { paymentMode: mode } });
    });
    return (await this.list(userId, undefined, orgId))[0] ?? null;
  }

  /** The bank transfer for an invoice arrived. */
  async markPaid(userId: string, invoiceId: string, reference: string) {
    await this.verification.assertPlatformAdmin(userId);
    return this.billing.markTransferPaid(userId, invoiceId, reference);
  }

  /** Extend (or shorten) the trial. An expired trial starts again. Paying organisations are left alone. */
  async setTrialEnd(userId: string, orgId: string, trialEndsOn: string) {
    await this.verification.assertPlatformAdmin(userId);
    await this.db.system(async (tx) => {
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).for('update');
      if (!s) throw new NotFoundException('Organisation not found');
      if (!['trialing', 'expired'].includes(s.status)) throw new BadRequestException(`The trial can only be changed while trialing or expired (now ${s.status})`);
      // End of that day in Riyadh (UTC+3).
      const trialEndsAt = new Date(`${trialEndsOn}T20:59:59Z`);
      if (trialEndsAt <= new Date()) throw new BadRequestException('Choose a date in the future');
      await tx.update(subscriptions).set({ status: 'trialing', trialEndsAt }).where(eq(subscriptions.orgId, orgId));
      await auditRaw(tx, { orgId, userId, requestId: 'platform', action: 'billing.trial_changed', entityType: 'subscription', entityId: orgId, before: { status: s.status, trialEndsAt: s.trialEndsAt }, after: { status: 'trialing', trialEndsAt } });
    });
    return (await this.list(userId, undefined, orgId))[0] ?? null;
  }
}

@ApiTags('platform')
@ApiBearerAuth()
@Controller('platform/organizations')
export class PlatformBillingController {
  constructor(private readonly svc: PlatformBillingService) {}

  @Get()
  list(@CurrentAuth() auth: { userId: string }, @Query() q: ListDto) { return this.svc.list(auth.userId, q.q); }

  @Put(':id/pricing') @HttpCode(200)
  pricing(@CurrentAuth() auth: { userId: string }, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: PricingDto) { return this.svc.setPricing(auth.userId, id, dto.pricing as CustomPricing | null); }

  @Put(':id/payment-mode') @HttpCode(200)
  mode(@CurrentAuth() auth: { userId: string }, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: ModeDto) { return this.svc.setPaymentMode(auth.userId, id, dto.mode); }

  @Post('invoices/:invoiceId/paid') @HttpCode(200)
  paid(@CurrentAuth() auth: { userId: string }, @Param('invoiceId', new ParseUUIDPipe()) invoiceId: string, @Body() dto: PaidDto) { return this.svc.markPaid(auth.userId, invoiceId, dto.reference); }

  @Post(':id/trial') @HttpCode(200)
  trial(@CurrentAuth() auth: { userId: string }, @Param('id', new ParseUUIDPipe()) id: string, @Body() dto: TrialDto) { return this.svc.setTrialEnd(auth.userId, id, dto.trialEndsOn); }
}
