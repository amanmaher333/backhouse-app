import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { type Tx, agentTasks, goodsReceiptLines, goodsReceipts, items, organizations, purchaseOrderLines, supplierInvoices, supplierItems, tradingRelationships } from '@boh/db';
import { Decimal, country, monthRange, openClaim, savingsMultiple, summariseSavings, switchSaving, zonedTimeToUtc, type SavingKind } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { BillingModule } from '../billing/billing.module.js';
import { BillingService } from '../billing/billing.service.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const SavingsSchema = z.object({ from: date.optional(), to: date.optional() }).refine((q) => !q.from || !q.to || q.from <= q.to, { message: 'from must be on or before to' });
class SavingsDto extends createZodDto(SavingsSchema) {}

const localDate = (t: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
/** Deliveries from a switched-to supplier count for a year after the switch. */
const SWITCH_WINDOW_DAYS = 365;

export interface SavingRow {
  kind: SavingKind;
  /** Local date it happened (credit received, duplicate rejected, delivery, dispute sent). */
  date: string;
  amount: string;
  supplier: { name: string; nameAr: string } | null;
  /** What it was about: an invoice ref and number, or an item. */
  subject: { type: 'invoice' | 'item'; id: string; label: string; labelAr: string };
  /** Extra numbers for the line (e.g. claim, credited, saving %). */
  detail?: Record<string, string | number>;
}

/**
 * Money Backhouse saved an organisation over a period, from records only. See docs/savings.md.
 */
@Injectable()
export class SavingsService {
  constructor(
    private readonly db: DbService,
    private readonly billing: BillingService,
  ) {}

  async report(a: AccessContext, q: { from?: string; to?: string }, now = new Date()) {
    const rows = await this.db.tenant(a.tenant, async (tx) => {
      const [org] = await tx.select({ country: organizations.country, currency: organizations.defaultCurrency, createdAt: organizations.createdAt }).from(organizations).where(eq(organizations.id, a.orgId));
      const tz = country(org!.country).timezone;
      const today = localDate(now, tz);
      const period = q.from && q.to ? { from: q.from, to: q.to } : monthRange(today);
      const t0 = zonedTimeToUtc(period.from, '00:00', tz);
      const t1 = zonedTimeToUtc(addDays(period.to, 1), '00:00', tz);
      const entries = await this.entries(tx, a.orgId, t0, t1, tz);
      return { org: org!, tz, today, period, entries };
    });
    const { period, entries, org, tz, today } = rows;
    const inPeriod = entries.filter((e) => e.kind !== 'claim_open');
    const totals = summariseSavings(entries);

    // What Backhouse cost over the same period (paid subscription invoices), and the plan price for context.
    const t0 = zonedTimeToUtc(period.from, '00:00', tz);
    const t1 = zonedTimeToUtc(addDays(period.to, 1), '00:00', tz);
    const cost = await this.billing.paidBetween(a.orgId, t0, t1);
    const sub = await this.billing.status(a.orgId);
    const plan = sub.status === 'free' ? null : await this.billing.monthlyEstimate(a.orgId);

    // During a trial: everything saved since it started, against what the plan will cost each month.
    let trial: { startedOn: string; endsOn: string; daysLeft: number; saved: string; monthlyPrice: string; multiple: number | null } | null = null;
    if (sub.status === 'trialing' && sub.trialEndsAt && plan) {
      const startedAt = await this.billing.trialStartedAt(a.orgId);
      const since = await this.db.tenant(a.tenant, (tx) => this.entries(tx, a.orgId, startedAt, now, tz));
      const saved = summariseSavings(since).saved;
      const endsAt = new Date(sub.trialEndsAt);
      trial = {
        startedOn: localDate(startedAt, tz),
        endsOn: localDate(endsAt, tz),
        daysLeft: Math.max(0, Math.ceil((endsAt.getTime() - now.getTime()) / 86400_000)),
        saved,
        monthlyPrice: plan.total,
        multiple: savingsMultiple(saved, plan.total),
      };
    }

    return {
      period,
      today,
      currency: org.currency,
      totals: {
        saved: totals.saved,
        inProgress: totals.inProgress,
        byKind: totals.byKind,
        cost: cost.total,
        multiple: savingsMultiple(totals.saved, cost.total),
        planMonthly: plan?.total ?? null,
      },
      trial,
      entries: [...inPeriod.sort((x, y) => y.date.localeCompare(x.date)), ...entries.filter((e) => e.kind === 'claim_open')],
    };
  }

  /** Saving rows dated within [t0, t1), plus claims still open now (whenever they were sent). */
  async entries(tx: Tx, orgId: string, t0: Date, t1: Date, tz: string): Promise<SavingRow[]> {
    const out: SavingRow[] = [];
    const sup = (r: { name: string | null; nameAr: string | null } | null) => (r?.name ? { name: r.name, nameAr: r.nameAr ?? r.name } : null);
    const invLabel = (ref: string, number: string | null) => (number ? `${ref} · ${number}` : ref);

    // Credit notes against invoices Backhouse disputed: count up to the claim, oldest credit first.
    const disputed = await tx
      .select({ id: supplierInvoices.id, ref: supplierInvoices.ref, number: supplierInvoices.number, status: supplierInvoices.status, claim: supplierInvoices.claimTotal, disputedAt: supplierInvoices.disputedAt, name: tradingRelationships.displayName, nameAr: tradingRelationships.displayNameAr })
      .from(supplierInvoices)
      .leftJoin(tradingRelationships, eq(tradingRelationships.id, supplierInvoices.relationshipId))
      .where(and(eq(supplierInvoices.orgId, orgId), isNotNull(supplierInvoices.disputedAt)));
    if (disputed.length) {
      const credits = await tx
        .select({ id: supplierInvoices.id, corrects: supplierInvoices.correctsInvoiceId, total: supplierInvoices.total, createdAt: supplierInvoices.createdAt, ref: supplierInvoices.ref })
        .from(supplierInvoices)
        .where(and(eq(supplierInvoices.orgId, orgId), eq(supplierInvoices.type, 'credit_note'), ne(supplierInvoices.status, 'rejected'), inArray(supplierInvoices.correctsInvoiceId, disputed.map((d) => d.id))))
        .orderBy(asc(supplierInvoices.createdAt));
      for (const d of disputed) {
        let credited = new Decimal(0);
        for (const c of credits.filter((x) => x.corrects === d.id)) {
          const room = Decimal.max(new Decimal(d.claim).minus(credited), 0);
          const counted = Decimal.min(new Decimal(c.total ?? 0), room);
          credited = credited.plus(new Decimal(c.total ?? 0));
          if (counted.gt(0) && c.createdAt >= t0 && c.createdAt < t1) {
            out.push({ kind: 'credit_note', date: localDate(c.createdAt, tz), amount: counted.toFixed(2), supplier: sup(d), subject: { type: 'invoice', id: d.id, label: invLabel(d.ref, d.number), labelAr: invLabel(d.ref, d.number) }, detail: { claim: d.claim, creditNote: c.ref } });
          }
        }
        if (d.status === 'disputed') {
          const open = openClaim(d.claim, credited);
          if (new Decimal(open).gt(0)) out.push({ kind: 'claim_open', date: localDate(d.disputedAt!, tz), amount: open, supplier: sup(d), subject: { type: 'invoice', id: d.id, label: invLabel(d.ref, d.number), labelAr: invLabel(d.ref, d.number) }, detail: { claim: d.claim, credited: credited.toFixed(2) } });
        }
      }
    }

    // Duplicate invoices rejected: the whole invoice wasn't paid twice.
    const dups = await tx
      .select({ id: supplierInvoices.id, ref: supplierInvoices.ref, number: supplierInvoices.number, total: supplierInvoices.total, rejectedAt: supplierInvoices.rejectedAt, name: tradingRelationships.displayName, nameAr: tradingRelationships.displayNameAr })
      .from(supplierInvoices)
      .leftJoin(tradingRelationships, eq(tradingRelationships.id, supplierInvoices.relationshipId))
      .where(
        and(
          eq(supplierInvoices.orgId, orgId),
          eq(supplierInvoices.status, 'rejected'),
          eq(supplierInvoices.type, 'invoice'),
          gte(supplierInvoices.rejectedAt, t0),
          sql`${supplierInvoices.rejectedAt} < ${t1}`,
          sql`${supplierInvoices.match} -> 'discrepancies' @> '[{"kind":"duplicate"}]'::jsonb`,
        ),
      );
    for (const d of dups) {
      if (d.total && new Decimal(d.total).gt(0)) out.push({ kind: 'duplicate', date: localDate(d.rejectedAt!, tz), amount: new Decimal(d.total).toFixed(2), supplier: sup(d), subject: { type: 'invoice', id: d.id, label: invLabel(d.ref, d.number), labelAr: invLabel(d.ref, d.number) } });
    }

    // Supplier switches made by Price Watch: deliveries from the new supplier, valued at the price gap at the time.
    const switches = await tx
      .select({ id: agentTasks.id, actions: agentTasks.actions, executedAt: agentTasks.executedAt })
      .from(agentTasks)
      .where(and(eq(agentTasks.orgId, orgId), eq(agentTasks.kind, 'price_rise'), eq(agentTasks.status, 'executed'), eq(agentTasks.chosenActionId, 'switch'), isNotNull(agentTasks.executedAt), lte(agentTasks.executedAt, t1)));
    for (const s of switches) {
      const action = s.actions.find((x) => x.id === 'switch');
      const p = action?.params as { supplierItemId?: string; savingPct?: number } | undefined;
      if (!p?.supplierItemId || !(Number(p.savingPct) > 0)) continue;
      const windowEnd = new Date(s.executedAt!.getTime() + SWITCH_WINDOW_DAYS * 86400_000);
      const from = s.executedAt! > t0 ? s.executedAt! : t0;
      const to = windowEnd < t1 ? windowEnd : t1;
      if (from >= to) continue;
      const received = await tx
        .select({ spend: sql<string>`coalesce(sum(${goodsReceiptLines.qty} * ${goodsReceiptLines.unitPrice}), 0)::text`, last: sql<Date | null>`max(${goodsReceipts.receivedAt})` })
        .from(goodsReceiptLines)
        .innerJoin(goodsReceipts, eq(goodsReceipts.id, goodsReceiptLines.receiptId))
        .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, goodsReceiptLines.poLineId))
        .where(and(eq(goodsReceiptLines.orgId, orgId), eq(purchaseOrderLines.supplierItemId, p.supplierItemId), gte(goodsReceipts.receivedAt, from), sql`${goodsReceipts.receivedAt} < ${to}`));
      const spend = received[0]?.spend ?? '0';
      const saving = switchSaving(spend, Number(p.savingPct));
      if (new Decimal(saving).lte(0)) continue;
      const [si] = await tx
        .select({ itemId: items.id, item: items.name, itemAr: items.nameAr, name: tradingRelationships.displayName, nameAr: tradingRelationships.displayNameAr })
        .from(supplierItems)
        .innerJoin(items, eq(items.id, supplierItems.itemId))
        .innerJoin(tradingRelationships, eq(tradingRelationships.id, supplierItems.relationshipId))
        .where(eq(supplierItems.id, p.supplierItemId));
      if (!si) continue;
      const last = received[0]?.last ? new Date(received[0].last) : to;
      out.push({ kind: 'supplier_switch', date: localDate(last, tz), amount: saving, supplier: sup(si), subject: { type: 'item', id: si.itemId, label: si.item, labelAr: si.itemAr ?? si.item }, detail: { spend: new Decimal(spend).toFixed(2), savingPct: Number(p.savingPct), switchedOn: localDate(s.executedAt!, tz) } });
    }
    return out;
  }
}

@ApiTags('savings')
@ApiBearerAuth()
@Controller('savings')
export class SavingsController {
  constructor(private readonly svc: SavingsService) {}

  @Get() @Requires('price:read')
  report(@Access() a: AccessContext, @Query() q: SavingsDto) { return this.svc.report(a, q); }
}

@Module({ imports: [BillingModule], controllers: [SavingsController], providers: [SavingsService], exports: [SavingsService] })
export class SavingsModule {}
