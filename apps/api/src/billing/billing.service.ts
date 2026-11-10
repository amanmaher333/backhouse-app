import { BadRequestException, HttpException, HttpStatus, Inject, Injectable, Logger, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { agents, billingEvents, billingInvoices, legalEntities, organizations, sites, subscriptions, type Tx } from '@boh/db';
import { addInterval, computeBill, pricingActive, TRIAL_DAYS, toHalalas, zatcaQr, type Bill, type BillingInterval, type CustomPricing } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService } from '../common/db.service.js';
import type { AccessContext } from '../common/access.js';
import { auditRaw } from '../common/audit.js';
import { PAYMENT_PROVIDER, type ChargeResult, type PaymentProvider } from './payments.js';

/** Statuses in which the organisation can use Kitchain fully. Others are read-only. */
export const ENTITLED_STATUSES = ['free', 'trialing', 'active', 'past_due'] as const;
/** Retries after a failed renewal: one day, then three days; the third failure suspends. */
const RETRY_DAYS = [1, 3];
const MAX_FAILED = 3;

type Sub = typeof subscriptions.$inferSelect;
type Invoice = typeof billingInvoices.$inferSelect;

export class SubscriptionInactiveError extends HttpException {
  constructor(status: string) {
    super(
      {
        statusCode: HttpStatus.PAYMENT_REQUIRED,
        code: 'subscription_inactive',
        status,
        message: 'Your Kitchain subscription is not active, so Kitchain is read-only. An admin can choose a plan under Billing.\nاشتراكك في Kitchain غير نشط، لذلك أصبح للقراءة فقط. يمكن للمسؤول اختيار خطة من صفحة الفوترة.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
}

/**
 * Subscriptions for restaurant groups: a free trial, then monthly or annual billing in SAR
 * (platform fee + each hired agent per active site, plus 15% VAT), charged to a saved card.
 * Failed renewals are retried; after the last retry the org becomes read-only until it pays.
 * Suppliers are free. Nobody at Kitchain needs to be involved in any of it.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger('Billing');

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  /** The subscription row for a new organisation (called inside sign-up). */
  static initialSubscription(orgId: string, type: string, now = new Date()): typeof subscriptions.$inferInsert {
    return type === 'restaurant_group'
      ? { orgId, plan: 'restaurant', status: 'trialing', trialEndsAt: new Date(now.getTime() + TRIAL_DAYS * 86400_000) }
      : { orgId, plan: type === 'supplier' ? 'supplier_free' : 'platform', status: 'free' };
  }

  static entitled(status: string | undefined | null) {
    return !!status && (ENTITLED_STATUSES as readonly string[]).includes(status);
  }

  /** Lightweight status for every member (banner, read-only mode). */
  async status(orgId: string) {
    const [s] = await this.db.system((tx) => tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)));
    if (!s) return { status: 'free', entitled: true, trialEndsAt: null, currentPeriodEnd: null, cancelAtPeriodEnd: false, hasPaymentMethod: false, plan: 'free' };
    return {
      plan: s.plan,
      status: s.status,
      entitled: BillingService.entitled(s.status),
      trialEndsAt: s.trialEndsAt,
      currentPeriodEnd: s.currentPeriodEnd,
      cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      interval: s.interval,
      hasPaymentMethod: !!s.paymentMethod,
    };
  }

  async assertEntitled(orgId: string) {
    const st = await this.status(orgId);
    if (!st.entitled) throw new SubscriptionInactiveError(st.status);
  }

  /** The bill for a period starting on `asOf` (default now), with any custom pricing agreed with the org. */
  private async billFor(tx: Tx, orgId: string, interval: BillingInterval, asOf: Date = new Date()): Promise<Bill> {
    const [sub] = await tx.select({ pricing: subscriptions.pricing }).from(subscriptions).where(eq(subscriptions.orgId, orgId));
    const [siteCount] = await tx.select({ n: sql<number>`count(*)::int` }).from(sites).where(and(eq(sites.orgId, orgId), eq(sites.isActive, true)));
    const hired = await tx
      .select({ kind: agents.kind, name: agents.name, nameAr: agents.nameAr })
      .from(agents)
      .where(and(eq(agents.orgId, orgId), eq(agents.status, 'active')))
      .orderBy(asc(agents.createdAt));
    return computeBill({
      interval,
      activeSites: siteCount?.n ?? 0,
      agents: hired.map((a) => ({ kind: a.kind, name: a.name, nameAr: a.nameAr ?? a.name })),
      pricing: (sub?.pricing as CustomPricing | null) ?? null,
      asOf: asOf.toISOString().slice(0, 10),
    });
  }

  /** A card is only needed when the period would cost something (custom pricing can make it free). */
  private async needsCard(tx: Tx, orgId: string, interval: BillingInterval, asOf?: Date) {
    return toHalalas((await this.billFor(tx, orgId, interval, asOf)).total) > 0;
  }

  /** What one month of the current plan costs (sites and hired agents as they are now). */
  monthlyEstimate(orgId: string): Promise<Bill> {
    return this.db.system((tx) => this.billFor(tx, orgId, 'month'));
  }

  /** Subscription invoices paid for periods issued in [from, to): what Kitchain actually cost. */
  async paidBetween(orgId: string, from: Date, to: Date): Promise<{ total: string; count: number }> {
    const [r] = await this.db.system((tx) =>
      tx
        .select({ total: sql<string>`coalesce(sum(${billingInvoices.total}), 0)::text`, count: sql<number>`count(*)::int` })
        .from(billingInvoices)
        .where(and(eq(billingInvoices.orgId, orgId), eq(billingInvoices.status, 'paid'), sql`${billingInvoices.issuedAt} >= ${from}`, sql`${billingInvoices.issuedAt} < ${to}`)),
    );
    return { total: Number(r?.total ?? 0).toFixed(2), count: r?.count ?? 0 };
  }

  /** When the trial began (the subscription is created with it). */
  async trialStartedAt(orgId: string): Promise<Date> {
    const [s] = await this.db.system((tx) => tx.select({ createdAt: subscriptions.createdAt, trialEndsAt: subscriptions.trialEndsAt }).from(subscriptions).where(eq(subscriptions.orgId, orgId)));
    if (s?.trialEndsAt) return new Date(Math.min(s.createdAt.getTime(), s.trialEndsAt.getTime() - TRIAL_DAYS * 86400_000));
    return s?.createdAt ?? new Date();
  }

  /** Everything the Billing page shows. */
  async overview(a: AccessContext) {
    return this.db.system(async (tx) => {
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, a.orgId));
      if (!s) throw new NotFoundException('No subscription');
      const [month, year] = await Promise.all([this.billFor(tx, a.orgId, 'month'), this.billFor(tx, a.orgId, 'year')]);
      const invoices = await tx
        .select({ id: billingInvoices.id, number: billingInvoices.number, status: billingInvoices.status, total: billingInvoices.total, issuedAt: billingInvoices.issuedAt, periodStart: billingInvoices.periodStart, periodEnd: billingInvoices.periodEnd, failureMessage: billingInvoices.failureMessage })
        .from(billingInvoices)
        .where(eq(billingInvoices.orgId, a.orgId))
        .orderBy(desc(billingInvoices.issuedAt))
        .limit(24);
      const pm = s.paymentMethod;
      return {
        plan: s.plan,
        status: s.status,
        entitled: BillingService.entitled(s.status),
        interval: s.interval,
        trialEndsAt: s.trialEndsAt,
        currentPeriodStart: s.currentPeriodStart,
        currentPeriodEnd: s.currentPeriodEnd,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
        failedAttempts: s.failedAttempts,
        nextRetryAt: s.nextRetryAt,
        paymentMethod: pm ? { brand: pm.brand, last4: pm.last4, expMonth: pm.expMonth, expYear: pm.expYear } : null,
        estimates: { month, year },
        pricing: pricingActive(s.pricing as CustomPricing | null, new Date().toISOString().slice(0, 10))
          ? (({ note: _note, ...rest }) => rest)(s.pricing as unknown as CustomPricing)
          : null,
        invoices,
        provider: this.payments.name,
        publishableKey: this.payments.name === 'moyasar' ? (this.config.MOYASAR_PUBLISHABLE_KEY ?? null) : null,
      };
    });
  }

  async setPaymentMethod(a: AccessContext, token: string) {
    let card;
    try {
      card = await this.payments.describeToken(token);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    await this.db.system(async (tx) => {
      await tx.update(subscriptions).set({ paymentMethod: { provider: this.payments.name, token, ...card } }).where(eq(subscriptions.orgId, a.orgId));
      await auditRaw(tx, { orgId: a.orgId, userId: a.userId, requestId: a.requestId, action: 'billing.payment_method_set', entityType: 'subscription', entityId: a.orgId, after: card });
    });
    return this.overview(a);
  }

  /**
   * Choose monthly or annual. During the trial nothing is charged until it ends. When the
   * organisation is not paying (expired, canceled, suspended), the first period is charged now.
   */
  async subscribe(a: AccessContext, interval: BillingInterval) {
    const outcome = await this.db.system(async (tx) => {
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, a.orgId)).for('update');
      if (!s || s.plan !== 'restaurant') throw new BadRequestException('This organisation has no paid plan');
      if (!s.paymentMethod && (await this.needsCard(tx, a.orgId, interval))) throw new BadRequestException('Add a card first');
      await auditRaw(tx, { orgId: a.orgId, userId: a.userId, requestId: a.requestId, action: 'billing.plan_chosen', entityType: 'subscription', entityId: a.orgId, before: { status: s.status, interval: s.interval }, after: { interval } });
      if (s.status === 'trialing' || s.status === 'active' || s.status === 'past_due') {
        await tx.update(subscriptions).set({ interval, cancelAtPeriodEnd: false }).where(eq(subscriptions.orgId, a.orgId));
        return { charged: null };
      }
      // Not paying: start a new period now.
      await tx.update(subscriptions).set({ interval, cancelAtPeriodEnd: false }).where(eq(subscriptions.orgId, a.orgId));
      const charged = await this.chargePeriod(tx, { ...s, interval }, new Date(), { interactive: true });
      return { charged };
    });
    if (outcome.charged?.status === 'failed') throw new BadRequestException(outcome.charged.message);
    const view = await this.overview(a);
    return { ...view, actionUrl: outcome.charged?.status === 'requires_action' ? outcome.charged.actionUrl : null };
  }

  async cancel(a: AccessContext) {
    await this.db.system(async (tx) => {
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, a.orgId)).for('update');
      if (!s || s.plan !== 'restaurant') throw new BadRequestException('This organisation has no paid plan');
      // In a trial, cancelling just means "don't start paying": the trial runs out and Kitchain becomes read-only.
      const values = s.status === 'trialing' ? { interval: null } : { cancelAtPeriodEnd: true };
      await tx.update(subscriptions).set(values).where(eq(subscriptions.orgId, a.orgId));
      await auditRaw(tx, { orgId: a.orgId, userId: a.userId, requestId: a.requestId, action: 'billing.canceled', entityType: 'subscription', entityId: a.orgId, after: values });
    });
    return this.overview(a);
  }

  async resume(a: AccessContext) {
    await this.db.system(async (tx) => {
      await tx.update(subscriptions).set({ cancelAtPeriodEnd: false }).where(eq(subscriptions.orgId, a.orgId));
      await auditRaw(tx, { orgId: a.orgId, userId: a.userId, requestId: a.requestId, action: 'billing.resumed', entityType: 'subscription', entityId: a.orgId });
    });
    return this.overview(a);
  }

  async invoice(a: AccessContext, id: string) {
    const [inv] = await this.db.tenant(a.tenant, (tx) => tx.select().from(billingInvoices).where(eq(billingInvoices.id, id)));
    if (!inv) throw new NotFoundException('invoice not found');
    return inv;
  }

  // ---------- charging ----------

  private async issueInvoice(tx: Tx, s: Sub, interval: BillingInterval, periodStart: Date): Promise<Invoice> {
    const bill = await this.billFor(tx, s.orgId, interval, periodStart);
    const [seq] = await tx.execute<{ n: string }>(sql`select nextval('billing_invoice_seq')::text as n`).then((r: any) => r.rows ?? r);
    const issuedAt = new Date();
    const number = `BOH-${issuedAt.getUTCFullYear()}-${String(seq!.n).padStart(6, '0')}`;
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, s.orgId));
    const [le] = await tx.select().from(legalEntities).where(eq(legalEntities.orgId, s.orgId)).orderBy(asc(legalEntities.createdAt)).limit(1);
    const seller = { name: this.config.BOH_SELLER_NAME, nameAr: this.config.BOH_SELLER_NAME_AR, vatNumber: this.config.BOH_SELLER_VAT, crNumber: this.config.BOH_SELLER_CR, address: this.config.BOH_SELLER_ADDRESS };
    const buyer = {
      name: le?.registryName ?? le?.name ?? org?.name,
      nameAr: le?.nameAr ?? org?.nameAr ?? null,
      vatNumber: le?.vatNumber ?? null,
      crNumber: le?.crNumber ?? null,
      address: le?.address ?? {},
      verified: le?.verificationStatus === 'verified',
    };
    const [inv] = await tx
      .insert(billingInvoices)
      .values({
        orgId: s.orgId,
        number,
        interval,
        periodStart,
        periodEnd: addInterval(periodStart, interval),
        lines: bill.lines as unknown as Record<string, unknown>[],
        subtotal: bill.subtotal,
        vat: bill.vat,
        total: bill.total,
        seller,
        buyer,
        qr: zatcaQr({ sellerName: seller.nameAr, vatNumber: seller.vatNumber, timestamp: issuedAt, total: bill.total, vatTotal: bill.vat }),
        issuedAt,
      })
      .returning();
    return inv!;
  }

  /** Issue an invoice for a period starting at `start` and charge the saved card. */
  private async chargePeriod(tx: Tx, s: Sub, start: Date, opts: { interactive: boolean }): Promise<ChargeResult> {
    const interval = (s.interval ?? 'month') as BillingInterval;
    const inv = await this.issueInvoice(tx, s, interval, start);
    return this.chargeInvoice(tx, s, inv, opts);
  }

  private async chargeInvoice(tx: Tx, s: Sub, inv: Invoice, opts: { interactive: boolean }): Promise<ChargeResult> {
    // Nothing to collect (e.g. a free founding-partner plan): paid without touching the card.
    if (toHalalas(inv.total) === 0) {
      // Payment references are unique, so each zero invoice gets its own.
      const paymentId = `no-charge:${inv.id}`;
      await this.markPaid(tx, inv, paymentId, inv.attempts);
      return { status: 'paid', paymentId };
    }
    const result = await this.payments.charge({
      amountHalalas: toHalalas(inv.total),
      token: s.paymentMethod!.token,
      description: `Kitchain ${inv.number}`,
      invoiceId: inv.id,
      callbackUrl: `${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/billing`,
    });
    const attempts = inv.attempts + 1;
    if (result.status === 'paid') {
      await this.markPaid(tx, inv, result.paymentId, attempts);
    } else if (result.status === 'requires_action' && opts.interactive) {
      await tx.update(billingInvoices).set({ providerPaymentId: result.paymentId, attempts }).where(eq(billingInvoices.id, inv.id));
    } else {
      // A renewal nobody is present for cannot pass 3-D Secure: treat it as a failure the admin must fix.
      const message = result.status === 'failed' ? result.message : 'The bank asked for card verification. Update the card under Billing.';
      await tx
        .update(billingInvoices)
        .set({ status: 'failed', failureMessage: message, attempts, providerPaymentId: result.paymentId })
        .where(eq(billingInvoices.id, inv.id));
      if (!opts.interactive) await this.recordFailure(tx, s);
      return { status: 'failed', paymentId: result.paymentId, message, retryable: true };
    }
    return result;
  }

  private async markPaid(tx: Tx, inv: Invoice, paymentId: string, attempts = inv.attempts) {
    await tx.update(billingInvoices).set({ status: 'paid', paidAt: new Date(), providerPaymentId: paymentId, attempts, failureMessage: null }).where(eq(billingInvoices.id, inv.id));
    await tx
      .update(subscriptions)
      .set({ status: 'active', currentPeriodStart: inv.periodStart, currentPeriodEnd: inv.periodEnd, failedAttempts: 0, nextRetryAt: null, interval: inv.interval })
      .where(eq(subscriptions.orgId, inv.orgId));
    await auditRaw(tx, { orgId: inv.orgId, userId: null, requestId: 'billing', action: 'billing.invoice_paid', entityType: 'billing_invoice', entityId: inv.id, after: { number: inv.number, total: inv.total } });
  }

  private async recordFailure(tx: Tx, s: Sub) {
    const failed = s.failedAttempts + 1;
    const suspend = failed >= MAX_FAILED;
    await tx
      .update(subscriptions)
      .set({ status: suspend ? 'suspended' : 'past_due', failedAttempts: failed, nextRetryAt: suspend ? null : new Date(Date.now() + RETRY_DAYS[failed - 1]! * 86400_000) })
      .where(eq(subscriptions.orgId, s.orgId));
    await auditRaw(tx, { orgId: s.orgId, userId: null, requestId: 'billing', action: suspend ? 'billing.suspended' : 'billing.payment_failed', entityType: 'subscription', entityId: s.orgId, after: { failedAttempts: failed } });
  }

  /**
   * Worker: end trials, renew periods, retry failed payments. Each subscription is handled
   * in its own transaction with a row lock, so overlapping workers do not double-charge.
   */
  async runDue(now = new Date()): Promise<{ trialsEnded: number; renewed: number; failed: number }> {
    const due = await this.db.system((tx) =>
      tx
        .select({ orgId: subscriptions.orgId })
        .from(subscriptions)
        .where(
          sql`(${subscriptions.status} = 'trialing' and ${subscriptions.trialEndsAt} <= ${now})
           or (${subscriptions.status} = 'active' and ${subscriptions.currentPeriodEnd} <= ${now})
           or (${subscriptions.status} = 'past_due' and ${subscriptions.nextRetryAt} <= ${now})`,
        ),
    );
    const out = { trialsEnded: 0, renewed: 0, failed: 0 };
    for (const { orgId } of due) {
      try {
        await this.db.system(async (tx) => {
          const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, orgId)).for('update', { skipLocked: true });
          if (!s) return;
          if (s.status === 'trialing' && s.trialEndsAt && s.trialEndsAt <= now) {
            out.trialsEnded++;
            if (!s.interval || (!s.paymentMethod && (await this.needsCard(tx, orgId, s.interval as BillingInterval, s.trialEndsAt)))) {
              await tx.update(subscriptions).set({ status: 'expired' }).where(eq(subscriptions.orgId, orgId));
              await auditRaw(tx, { orgId, userId: null, requestId: 'billing', action: 'billing.trial_expired', entityType: 'subscription', entityId: orgId });
              return;
            }
            const r = await this.chargePeriod(tx, s, s.trialEndsAt, { interactive: false });
            if (r.status === 'paid') out.renewed++;
            else out.failed++;
          } else if (s.status === 'active' && s.currentPeriodEnd && s.currentPeriodEnd <= now) {
            if (s.cancelAtPeriodEnd || (!s.paymentMethod && (await this.needsCard(tx, orgId, (s.interval ?? 'month') as BillingInterval, s.currentPeriodEnd)))) {
              await tx.update(subscriptions).set({ status: 'canceled' }).where(eq(subscriptions.orgId, orgId));
              await auditRaw(tx, { orgId, userId: null, requestId: 'billing', action: 'billing.ended', entityType: 'subscription', entityId: orgId });
              return;
            }
            const r = await this.chargePeriod(tx, s, s.currentPeriodEnd, { interactive: false });
            if (r.status === 'paid') out.renewed++;
            else out.failed++;
          } else if (s.status === 'past_due' && s.nextRetryAt && s.nextRetryAt <= now) {
            const [inv] = await tx
              .select()
              .from(billingInvoices)
              .where(and(eq(billingInvoices.orgId, orgId), eq(billingInvoices.status, 'failed')))
              .orderBy(desc(billingInvoices.issuedAt))
              .limit(1);
            if (!inv || !s.paymentMethod) return this.recordFailure(tx, s);
            const r = await this.chargeInvoice(tx, s, inv, { interactive: false });
            if (r.status === 'paid') out.renewed++;
            else out.failed++;
          }
        });
      } catch (err) {
        this.logger.error(`billing ${orgId}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Pay a failed invoice now (after updating the card), from the Billing page. */
  async payNow(a: AccessContext) {
    const result = await this.db.system(async (tx) => {
      const [s] = await tx.select().from(subscriptions).where(eq(subscriptions.orgId, a.orgId)).for('update');
      if (!s?.paymentMethod) throw new BadRequestException('Add a card first');
      const [inv] = await tx
        .select()
        .from(billingInvoices)
        .where(and(eq(billingInvoices.orgId, a.orgId), inArray(billingInvoices.status, ['failed', 'open'])))
        .orderBy(desc(billingInvoices.issuedAt))
        .limit(1);
      if (inv) return this.chargeInvoice(tx, s, inv, { interactive: true });
      if (['expired', 'canceled', 'suspended'].includes(s.status)) return this.chargePeriod(tx, { ...s, interval: s.interval ?? 'month' }, new Date(), { interactive: true });
      throw new BadRequestException('Nothing to pay');
    });
    if (result.status === 'failed') throw new BadRequestException(result.message);
    return { ...(await this.overview(a)), actionUrl: result.status === 'requires_action' ? result.actionUrl : null };
  }

  // ---------- webhooks ----------

  async handleWebhook(body: any) {
    const evt = this.payments.parseWebhook(body);
    if (!evt) throw new UnauthorizedException('Invalid webhook');
    return this.db.system(async (tx) => {
      const [row] = await tx
        .insert(billingEvents)
        .values({ provider: this.payments.name, eventId: evt.id, type: evt.type, payload: body })
        .onConflictDoNothing()
        .returning({ id: billingEvents.id });
      if (!row) return { duplicate: true };
      const [inv] = await tx.select().from(billingInvoices).where(eq(billingInvoices.providerPaymentId, evt.paymentId)).for('update');
      if (!inv || inv.status === 'paid') return { ignored: true };
      if (evt.type === 'payment_paid') await this.markPaid(tx, inv, evt.paymentId);
      else if (evt.type === 'payment_failed') {
        await tx.update(billingInvoices).set({ status: 'failed', failureMessage: evt.message ?? 'Payment failed' }).where(eq(billingInvoices.id, inv.id));
      }
      return { handled: evt.type };
    });
  }

  /** Development only: complete a simulated 3-D Secure check, as the provider's webhook would. */
  async simulateConfirm(paymentId: string, outcome: 'paid' | 'failed') {
    if (this.payments.name !== 'simulated' || this.config.NODE_ENV === 'production') throw new NotFoundException();
    return this.handleWebhook({ id: `sim_evt_${paymentId}_${outcome}`, type: `payment_${outcome}`, secret_token: 'simulated', data: { id: paymentId, source: { message: outcome === 'failed' ? 'Verification failed' : undefined } } });
  }
}

