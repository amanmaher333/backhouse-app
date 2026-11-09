import { ForbiddenException } from '@nestjs/common';
import { and, asc, eq, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
  itemSiteSettings,
  items,
  packs,
  purchaseOrders,
  sites,
  supplierItems,
  tradingRelationships,
  type AgentAction,
} from '@boh/db';
import { Decimal, addDays, daysBetween, formatMoney, localParts, orderTotals, packsToOrder } from '@boh/domain';
import type { TaskText } from './llm.js';
import type { AgentDefinition, AgentOutput, EventRow, ExecuteContext, RunContext, TaskProposal } from './types.js';

/**
 * Purchasing: keeps every site stocked.
 *
 * For each site, items with a par level and a known stock level are checked:
 * at or below the reorder point (or par, when no reorder point is set), it
 * orders enough whole packs to get back to par, minus what is already on
 * order. Lines are grouped into one proposed order per supplier, using the
 * preferred supplier (else the cheapest), with the next delivery date from
 * the supplier's schedule. It also chases sent orders whose delivery is late.
 */

interface SuggestedLine {
  supplierItemId: string;
  itemId: string;
  item: string;
  itemAr: string;
  pack: string;
  packAr: string;
  baseUnit: string;
  onHand: string;
  par: string;
  reorderAt: string;
  onOrder: string;
  onHandAr: string;
  parAr: string;
  reorderAtAr: string;
  qty: number;
  unitPrice: string;
}

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);
const fmt = (v: Decimal.Value | null | undefined, c: string) => formatMoney(v, c, 'en');
const fmtAr = (v: Decimal.Value | null | undefined, c: string) => formatMoney(v, c, 'ar');

const qtyLabel = (base: Decimal.Value, unit: string, ar = false) => {
  const n = new Decimal(base);
  const u = ar ? { kg: 'كجم', g: 'غ', L: 'لتر', ml: 'مل', each: 'حبة' } : { kg: 'kg', g: 'g', L: 'L', ml: 'ml', each: 'each' };
  if (unit === 'g') return n.gte(1000) ? `${n.div(1000).toDecimalPlaces(2)} ${u.kg}` : `${n.toDecimalPlaces(0)} ${u.g}`;
  if (unit === 'ml') return n.gte(1000) ? `${n.div(1000).toDecimalPlaces(2)} ${u.L}` : `${n.toDecimalPlaces(0)} ${u.ml}`;
  return `${n.toDecimalPlaces(2)} ${u.each}`;
};
/** Keep a left-to-right value (an ISO date) in order inside Arabic text. */
const ltr = (v: string | null | undefined) => `\u2066${v ?? '—'}\u2069`;

async function siteProposals(ctx: RunContext, siteIds: string[]): Promise<{ proposals: TaskProposal[]; expirePrefixes: string[] }> {
  const { tx, settings } = ctx;
  const includeUncounted = Boolean(settings.includeUncounted ?? false);
  const proposals: TaskProposal[] = [];
  if (!siteIds.length) return { proposals, expirePrefixes: [] };
  const siteRows = await tx.select().from(sites).where(and(inArray(sites.id, siteIds), eq(sites.isActive, true)));

  const pars = await tx
    .select({ s: itemSiteSettings, item: items })
    .from(itemSiteSettings)
    .innerJoin(items, eq(items.id, itemSiteSettings.itemId))
    .where(and(inArray(itemSiteSettings.siteId, siteIds), isNotNull(itemSiteSettings.parLevel), eq(itemSiteSettings.isStocked, true), eq(items.isActive, true)))
    .orderBy(asc(items.code)); // stable line order, so a re-run produces the same draft
  const balances = await ctx.services.stock.balances(tx, siteIds);
  const balanceBy = new Map(balances.map((b) => [`${b.siteId}:${b.itemId}`, b]));
  const onOrderRows = await ctx.services.procurement.onOrder(tx, siteIds);
  const onOrderBy = new Map(onOrderRows.map((r) => [`${r.siteId}:${r.itemId}`, new Decimal(r.qtyBase ?? 0)]));

  // Supplier lines for the items involved: preferred first, then cheapest per base unit.
  const itemIds = [...new Set(pars.map((p) => p.item.id))];
  const lines = itemIds.length
    ? await tx
        .select({ si: supplierItems, pack: packs, rel: tradingRelationships })
        .from(supplierItems)
        .innerJoin(packs, eq(packs.id, supplierItems.packId))
        .innerJoin(tradingRelationships, eq(tradingRelationships.id, supplierItems.relationshipId))
        .where(and(inArray(supplierItems.itemId, itemIds), eq(supplierItems.isActive, true), eq(tradingRelationships.isActive, true), eq(packs.isOrderable, true)))
    : [];
  const bestLine = (itemId: string) =>
    lines
      .filter((l) => l.si.itemId === itemId)
      .sort((a, b) => Number(b.si.isPreferred) - Number(a.si.isPreferred) || new Decimal(a.si.currentPrice).div(a.pack.baseQty).cmp(new Decimal(b.si.currentPrice).div(b.pack.baseQty)))[0];

  for (const site of siteRows) {
    const groups = new Map<string, { rel: (typeof lines)[number]['rel']; lines: SuggestedLine[] }>();
    let uncounted = 0;
    let noSupplier = 0;
    for (const p of pars.filter((x) => x.s.siteId === site.id)) {
      const bal = balanceBy.get(`${site.id}:${p.item.id}`);
      if (!bal && !includeUncounted) {
        uncounted++;
        continue;
      }
      const onHand = new Decimal(bal?.qtyOnHand ?? 0);
      const par = new Decimal(p.s.parLevel!);
      const reorderAt = new Decimal(p.s.reorderPoint ?? p.s.parLevel!);
      if (onHand.gt(reorderAt)) continue;
      const onOrder = onOrderBy.get(`${site.id}:${p.item.id}`) ?? new Decimal(0);
      const line = bestLine(p.item.id);
      if (!line) {
        noSupplier++;
        continue;
      }
      const qty = packsToOrder({ par, onHand, onOrder, packBaseQty: line.pack.baseQty });
      if (qty <= 0) continue;
      const g = groups.get(line.rel.id) ?? { rel: line.rel, lines: [] };
      g.lines.push({
        supplierItemId: line.si.id,
        itemId: p.item.id,
        item: p.item.name,
        itemAr: p.item.nameAr ?? p.item.name,
        pack: line.pack.name,
        packAr: line.pack.nameAr ?? line.pack.name,
        baseUnit: p.item.baseUnit,
        onHand: qtyLabel(onHand, p.item.baseUnit),
        par: qtyLabel(par, p.item.baseUnit),
        reorderAt: qtyLabel(reorderAt, p.item.baseUnit),
        onOrder: qtyLabel(onOrder, p.item.baseUnit),
        onHandAr: qtyLabel(onHand, p.item.baseUnit, true),
        parAr: qtyLabel(par, p.item.baseUnit, true),
        reorderAtAr: qtyLabel(reorderAt, p.item.baseUnit, true),
        qty,
        unitPrice: line.si.currentPrice,
      });
      groups.set(line.rel.id, g);
    }

    for (const g of groups.values()) {
      const cur = g.rel.currency;
      const totals = orderTotals(g.lines.map((l) => ({ qty: l.qty, unitPrice: l.unitPrice })), g.rel.taxRate);
      const deliveryDate = await ctx.services.procurement.suggestDeliveryDate(tx, g.rel.id, site.id);
      const belowMinimum = g.rel.minOrderValue !== null && new Decimal(totals.subtotal).lt(g.rel.minOrderValue);
      const siteName = site.name;
      const siteNameAr = site.nameAr ?? site.name;
      const sup = g.rel.displayName;
      const supAr = g.rel.displayNameAr ?? g.rel.displayName;
      const evidence = {
        site: { id: site.id, name: siteName, nameAr: siteNameAr },
        supplier: { id: g.rel.id, name: sup, nameAr: supAr, minOrderValue: g.rel.minOrderValue },
        deliveryDate,
        currency: cur,
        lines: g.lines.map((l, i) => ({ ...l, lineTotal: totals.lineTotals[i] })),
        subtotal: totals.subtotal,
        tax: totals.tax,
        total: totals.total,
        belowMinimum,
        skipped: { uncounted, noSupplier },
      };
      const template = (): TaskText => ({
        title: `Order for ${siteName} from ${sup}: ${g.lines.length} ${g.lines.length === 1 ? 'item' : 'items'}, ${fmt(totals.total, cur)}`,
        title_ar: `طلب لفرع ${siteNameAr} من ${supAr}: ${g.lines.length} ${g.lines.length === 1 ? 'صنف' : 'أصناف'}، ${fmtAr(totals.total, cur)}`,
        summary: `${g.lines
          .slice(0, 3)
          .map((l) => `${l.item} is at ${l.onHand} (reorder at ${l.reorderAt}, par ${l.par})`)
          .join('; ')}${g.lines.length > 3 ? `; and ${g.lines.length - 3} more` : ''}. Suggested delivery ${deliveryDate}.${belowMinimum ? ` Below the supplier's minimum order of ${fmt(g.rel.minOrderValue!, cur)}.` : ''}`,
        summary_ar: `${g.lines
          .slice(0, 3)
          .map((l) => `${l.itemAr} عند ${l.onHandAr} (إعادة الطلب عند ${l.reorderAtAr}، المستهدف ${l.parAr})`)
          .join('؛ ')}${g.lines.length > 3 ? `؛ و${g.lines.length - 3} أخرى` : ''}. التوصيل المقترح ${ltr(deliveryDate)}.${belowMinimum ? ` أقل من الحد الأدنى للطلب لدى المورد ${fmtAr(g.rel.minOrderValue!, cur)}.` : ''}`,
        message: '',
        message_ar: '',
      });
      const written = await ctx.llm.write(
        'Stock at a restaurant site is at or below its reorder point. Write the headline and summary for a proposed purchase order (which items are low, the order total and the delivery date). No supplier message is needed: leave message fields empty.',
        evidence,
        template,
      );
      ctx.usage.inputTokens += written.inputTokens;
      ctx.usage.outputTokens += written.outputTokens;
      ctx.usage.costUsd += written.costUsd;
      if (written.model) ctx.usage.model = written.model;
      const action: Omit<AgentAction, 'autonomy'> = {
        id: 'order',
        type: 'create_po',
        label: `Create the order (${fmt(totals.total, cur)}, delivery ${deliveryDate})`,
        labelAr: `أنشئ الطلب (${fmtAr(totals.total, cur)}، التوصيل ${ltr(deliveryDate)})`,
        params: {
          siteId: site.id,
          relationshipId: g.rel.id,
          deliveryDate,
          total: totals.total,
          belowMinimum,
          lines: g.lines.map((l) => ({ supplierItemId: l.supplierItemId, qty: l.qty })),
        },
      };
      proposals.push({
        kind: 'reorder',
        subjectKey: `order:${site.id}:${g.rel.id}`,
        priority: g.lines.some((l) => new Decimal(balanceBy.get(`${site.id}:${l.itemId}`)?.qtyOnHand ?? 0).lte(0)) ? 1 : 2,
        title: written.text.title,
        titleAr: written.text.title_ar,
        summary: written.text.summary,
        summaryAr: written.text.summary_ar,
        evidence,
        actions: [action],
        writtenBy: written.writtenBy,
      });
    }
  }
  return { proposals, expirePrefixes: siteRows.map((s) => `order:${s.id}:`) };
}

/** Sent orders whose delivery date has passed without a full delivery. */
async function overdueProposals(ctx: RunContext): Promise<{ proposals: TaskProposal[]; expirePrefixes: string[] }> {
  const { tx } = ctx;
  // "Late" is judged in each site's own time zone; the query takes anything due up to tomorrow (UTC).
  const tomorrow = addDays(new Date().toISOString().slice(0, 10), 1);
  const rows = await tx
    .select({ po: purchaseOrders, rel: tradingRelationships, site: sites })
    .from(purchaseOrders)
    .innerJoin(tradingRelationships, eq(tradingRelationships.id, purchaseOrders.relationshipId))
    .innerJoin(sites, eq(sites.id, purchaseOrders.siteId))
    .where(and(inArray(purchaseOrders.status, ['sent', 'partially_received']), isNotNull(purchaseOrders.deliveryDate), lt(purchaseOrders.deliveryDate, tomorrow)));
  const proposals: TaskProposal[] = [];
  for (const { po, rel, site } of rows) {
    const today = localParts(new Date(), site.timezone).date;
    if (po.deliveryDate! >= today) continue;
    const cur = po.currency;
    const late = daysBetween(po.deliveryDate!, today);
    const sup = rel.displayName;
    const supAr = rel.displayNameAr ?? rel.displayName;
    const message = `Hello ${sup} team, our order ${po.number} for ${site.name} was due on ${po.deliveryDate} and has not fully arrived. Could you confirm when it will be delivered? Thank you.`;
    const messageAr = `مرحبًا فريق ${supAr}، طلبنا ${po.number} لفرع ${site.nameAr ?? site.name} كان موعد توصيله ${ltr(po.deliveryDate)} ولم يصل كاملًا بعد. نرجو تأكيد موعد التوصيل. شكرًا لكم.`;
    proposals.push({
      kind: 'po_overdue',
      subjectKey: `overdue:${po.id}`,
      priority: 1,
      title: `${po.number} from ${sup} is ${late} ${late === 1 ? 'day' : 'days'} late`,
      titleAr: `الطلب ${po.number} من ${supAr} متأخر ${late} ${late === 1 ? 'يوم' : 'أيام'}`,
      summary: `The delivery for ${site.name} was due on ${po.deliveryDate} (${fmt(po.total, cur)}). ${po.status === 'partially_received' ? 'Part of it has arrived.' : 'Nothing has been received yet.'}`,
      summaryAr: `كان موعد التوصيل لفرع ${site.nameAr ?? site.name} في ${ltr(po.deliveryDate)} (${fmtAr(po.total, cur)}). ${po.status === 'partially_received' ? 'وصل جزء منه.' : 'لم يُستلم شيء بعد.'}`,
      evidence: { poId: po.id, number: po.number, deliveryDate: po.deliveryDate, daysLate: late, total: po.total, status: po.status, site: { id: site.id, name: site.name, nameAr: site.nameAr }, supplier: { id: rel.id, name: sup, nameAr: supAr } },
      actions: rel.contactEmail || rel.contactPhone
        ? [{ id: 'contact', type: 'contact_supplier', label: `Ask ${sup} when it will arrive`, labelAr: `اسأل ${supAr} عن موعد الوصول`, params: { supplierId: rel.id, channel: rel.orderChannel, email: rel.contactEmail, phone: rel.contactPhone, message, messageAr } }]
        : [],
      writtenBy: 'template',
    });
  }
  return { proposals, expirePrefixes: ['overdue:'] };
}

/** Suppliers' problems and messages about an order (from WhatsApp or the order link) become inbox tasks. */
async function supplierReplyProposals(ctx: RunContext, evts: EventRow[]): Promise<{ proposals: TaskProposal[]; expirePrefixes: string[] }> {
  const replies = evts.filter((e) => e.type === 'po.supplier_replied' && ['problem', 'message'].includes(String((e.payload as { kind?: string }).kind)));
  const proposals: TaskProposal[] = [];
  for (const e of replies) {
    const p = e.payload as { poId: string; number: string; relationshipId: string; kind: 'problem' | 'message'; text: string; via: string };
    const [row] = await ctx.tx
      .select({ rel: tradingRelationships, site: sites, po: purchaseOrders })
      .from(purchaseOrders)
      .innerJoin(tradingRelationships, eq(tradingRelationships.id, purchaseOrders.relationshipId))
      .innerJoin(sites, eq(sites.id, purchaseOrders.siteId))
      .where(eq(purchaseOrders.id, p.poId));
    if (!row) continue;
    const sup = row.rel.displayName;
    const supAr = row.rel.displayNameAr ?? sup;
    const problem = p.kind === 'problem';
    proposals.push({
      kind: 'supplier_reply',
      subjectKey: `supplier_reply:${p.poId}:${e.id}`,
      priority: problem ? 1 : 2,
      title: problem ? `${sup} reported a problem with ${p.number}` : `${sup} replied about ${p.number}`,
      titleAr: problem ? `${supAr} أبلغ عن مشكلة في الطلب ${p.number}` : `${supAr} ردّ بخصوص الطلب ${p.number}`,
      summary: `“${p.text}”`,
      summaryAr: `«${p.text}»`,
      evidence: { poId: p.poId, number: p.number, text: p.text, replyKind: p.kind, via: p.via, status: row.po.status, deliveryDate: row.po.deliveryDate, site: { id: row.site.id, name: row.site.name, nameAr: row.site.nameAr }, supplier: { id: row.rel.id, name: sup, nameAr: supAr } },
      actions: [],
      sourceEventId: e.id,
      writtenBy: 'template',
    });
  }
  return { proposals, expirePrefixes: [] };
}

const merge = (...outs: { proposals: TaskProposal[]; expirePrefixes: string[] }[]): AgentOutput => ({
  proposals: outs.flatMap((o) => o.proposals),
  expirePrefixes: outs.flatMap((o) => o.expirePrefixes),
});

export const purchasing: AgentDefinition = {
  kind: 'purchasing',
  name: 'Purchasing',
  nameAr: 'المشتريات',
  description: 'Keeps every site stocked: drafts orders per supplier from par levels, stock and deliveries already on the way, and chases late deliveries.',
  descriptionAr: 'يحافظ على مخزون كل فرع: يصيغ الطلبات لكل مورد حسب المستويات المستهدفة والمخزون والتوريدات القادمة، ويتابع التوريدات المتأخرة.',
  roleKey: 'agent_purchasing',
  subscribes: ['stock.changed', 'po.status_changed', 'po.received', 'po.supplier_replied'],
  defaultSettings: { maxAutoOrderSar: 1500, includeUncounted: false },
  actionTypes: [
    { type: 'create_po', label: 'Create purchase orders', labelAr: 'إنشاء أوامر الشراء', allowed: ['suggest', 'approve', 'auto'], default: 'approve', requires: 'po:manage' },
    { type: 'contact_supplier', label: 'Chase late deliveries', labelAr: 'متابعة التوريدات المتأخرة', allowed: ['suggest', 'approve'], default: 'approve', requires: 'supplier:read' },
  ],

  async handleEvents(ctx, evts: EventRow[]) {
    const siteIds = [...new Set(evts.map((e) => (e.payload as { siteId?: string }).siteId).filter((s): s is string => Boolean(s)))];
    const out = [await siteProposals(ctx, siteIds)];
    if (evts.some((e) => e.type !== 'stock.changed')) out.push(await overdueProposals(ctx));
    out.push(await supplierReplyProposals(ctx, evts));
    return merge(...out);
  },

  async scan(ctx) {
    const all = await ctx.tx.select({ id: sites.id }).from(sites).where(eq(sites.isActive, true));
    return merge(await siteProposals(ctx, all.map((s) => s.id)), await overdueProposals(ctx));
  },

  async guardrail(action: AgentAction, ctx: ExecuteContext) {
    if (action.type !== 'create_po') return null;
    const p = action.params as { siteId: string; relationshipId: string; total: string; belowMinimum: boolean; lines: { supplierItemId: string }[] };
    const [rel] = await ctx.tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, p.relationshipId));
    if (!rel?.isActive) return 'The supplier is no longer active';
    const active = await ctx.tx
      .select({ id: supplierItems.id })
      .from(supplierItems)
      .where(and(inArray(supplierItems.id, p.lines.map((l) => l.supplierItemId)), eq(supplierItems.isActive, true)));
    if (active.length !== p.lines.length) return 'Some items are no longer in the supplier’s catalogue';
    // An order to this supplier for this site may have been placed since the suggestion.
    const [recent] = await ctx.tx
      .select({ n: sql<number>`count(*)::int` })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.siteId, p.siteId), eq(purchaseOrders.relationshipId, p.relationshipId), inArray(purchaseOrders.status, ['draft', 'pending_approval', 'approved']), sql`${purchaseOrders.createdAt} > ${ctx.task.createdAt}`));
    if ((recent?.n ?? 0) > 0) return 'An order to this supplier for this site was created after this suggestion';
    if (ctx.automatic) {
      const cur = rel.currency;
      const max = Number(ctx.settings.maxAutoOrderSar ?? 1500);
      if (new Decimal(p.total).gt(max)) return `Order total ${fmt(p.total, cur)} is above the ${fmt(max, cur)} allowed without approval`;
      if (p.belowMinimum) return 'The order is below the supplier’s minimum';
    }
    return null;
  },

  async execute(action: AgentAction, ctx: ExecuteContext) {
    if (action.type === 'create_po') {
      const p = action.params as { siteId: string; relationshipId: string; deliveryDate: string; lines: { supplierItemId: string; qty: number }[] };
      // The approving person must be allowed to order for this site.
      if (ctx.approver && !ctx.approver.can('po:manage', p.siteId)) throw new ForbiddenException('You cannot create orders for this site');
      const po = await ctx.services.procurement.createInTx(
        ctx.tx,
        ctx.access,
        { siteId: p.siteId, relationshipId: p.relationshipId, deliveryDate: p.deliveryDate, notes: null, lines: p.lines, submit: true },
        { source: 'agent', agentTaskId: ctx.task.id },
      );
      return { poId: po.id, number: po.number, status: po.status, total: po.total, approvalReason: po.approvalReason };
    }
    if (action.type === 'contact_supplier') {
      const p = action.params as { supplierId?: string; channel?: string; email?: string | null; phone?: string | null; message: string; messageAr: string };
      const body = `${p.messageAr}\n\n${p.message}`;
      // Suppliers who take orders on WhatsApp get the chaser from Backhouse directly, once a person approved it.
      if (p.channel === 'whatsapp' && p.supplierId) {
        const ev = ctx.task.evidence as { poId?: string; number?: string };
        const sent = await ctx.services.messenger.sendFollowUp(ctx.tx, ctx.access, { relationshipId: p.supplierId, poId: ev.poId ?? null, about: `الطلب ${ev.number ?? ''}`.trim(), message: p.message, messageAr: p.messageAr });
        if (sent) return { sentDirect: true, to: sent.to, messageId: sent.messageId };
      }
      return {
        prepared: true,
        mailto: p.email ? `mailto:${p.email}?subject=${encodeURIComponent('Late delivery / تأخر التوصيل')}&body=${encodeURIComponent(body)}` : null,
        whatsapp: p.phone ? `https://wa.me/${p.phone.replace(/\D/g, '')}?text=${encodeURIComponent(body)}` : null,
      };
    }
    throw new Error(`Unknown action ${action.type}`);
  },
};


