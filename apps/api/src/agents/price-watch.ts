import { and, desc, eq, gte, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import {
  items,
  packs,
  supplierItemPrices,
  supplierItems,
  tradingRelationships,
  type AgentAction,
  type Tx,
} from '@boh/db';
import { Decimal } from '@boh/domain';
import { audit } from '../common/audit.js';
import type { TaskText } from './llm.js';
import type { AgentDefinition, EventRow, ExecuteContext, RunContext, TaskProposal } from './types.js';

/**
 * Price Watch: notices supplier price rises and proposes a response.
 *
 * Deterministic part (code): which rises matter, cost per kg/L/each, cheaper
 * suppliers for the same item or the same shared ingredient, savings.
 * Language part (Claude or templates): bilingual title, summary and a
 * message to the supplier.
 */

interface PriceRise {
  supplierItemId: string;
  price: string;
  previousPrice: string;
  at: string;
  eventId?: number;
}

const money = (v: string | number) => new Decimal(v).toFixed(2);
const pct1 = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
const unitWord = (baseUnit: string) => (baseUnit === 'g' ? { en: 'kg', ar: 'كجم', f: 1000 } : baseUnit === 'ml' ? { en: 'L', ar: 'لتر', f: 1000 } : { en: 'each', ar: 'حبة', f: 1 });

async function buildProposal(ctx: RunContext, rise: PriceRise): Promise<TaskProposal | null> {
  const { tx, settings } = ctx;
  const minPct = Number(settings.minIncreasePct ?? 5);
  const oldP = new Decimal(rise.previousPrice);
  const newP = new Decimal(rise.price);
  if (oldP.lte(0) || newP.lte(oldP)) return null;
  const changePct = newP.minus(oldP).div(oldP).mul(100).toNumber();
  if (changePct < minPct) return null;

  const [line] = await tx
    .select({
      si: supplierItems,
      item: items,
      pack: packs,
      rel: tradingRelationships,
    })
    .from(supplierItems)
    .innerJoin(items, eq(items.id, supplierItems.itemId))
    .innerJoin(packs, eq(packs.id, supplierItems.packId))
    .innerJoin(tradingRelationships, eq(tradingRelationships.id, supplierItems.relationshipId))
    .where(eq(supplierItems.id, rise.supplierItemId));
  if (!line || !line.si.isActive || !line.rel.isActive) return null;
  // The price may have moved again since the event; always reason about the current price.
  const current = new Decimal(line.si.currentPrice);
  if (current.lte(oldP)) return null;

  const u = unitWord(line.item.baseUnit);
  const costNew = current.div(line.pack.baseQty);
  const costOld = oldP.div(line.pack.baseQty);

  // Cheaper active lines for the same item, or for any item linked to the same shared ingredient.
  const sameIngredient = line.item.canonicalId
    ? sql`(${supplierItems.itemId} = ${line.item.id} or ${items.canonicalId} = ${line.item.canonicalId})`
    : sql`${supplierItems.itemId} = ${line.item.id}`;
  const others = await tx
    .select({
      id: supplierItems.id,
      itemId: items.id,
      itemName: items.name,
      itemNameAr: items.nameAr,
      supplierId: tradingRelationships.id,
      supplierName: tradingRelationships.displayName,
      supplierNameAr: tradingRelationships.displayNameAr,
      packName: packs.name,
      price: supplierItems.currentPrice,
      baseQty: packs.baseQty,
      isPreferred: supplierItems.isPreferred,
    })
    .from(supplierItems)
    .innerJoin(items, eq(items.id, supplierItems.itemId))
    .innerJoin(packs, eq(packs.id, supplierItems.packId))
    .innerJoin(tradingRelationships, eq(tradingRelationships.id, supplierItems.relationshipId))
    .where(
      and(
        ne(supplierItems.id, line.si.id),
        eq(supplierItems.isActive, true),
        eq(tradingRelationships.isActive, true),
        eq(items.isActive, true),
        eq(items.baseUnit, line.item.baseUnit),
        sameIngredient,
      ),
    );
  const alternatives = others
    .map((o) => {
      const cost = new Decimal(o.price).div(o.baseQty);
      return { ...o, costPerBase: cost.toString(), savingPct: costNew.minus(cost).div(costNew).mul(100).toNumber() };
    })
    .filter((o) => o.savingPct > 0)
    .sort((a, b) => b.savingPct - a.savingPct)
    .slice(0, 3);

  const history = await tx
    .select({ price: supplierItemPrices.price, at: supplierItemPrices.effectiveFrom, source: supplierItemPrices.source })
    .from(supplierItemPrices)
    .where(and(eq(supplierItemPrices.supplierItemId, line.si.id), isNull(supplierItemPrices.siteId)))
    .orderBy(desc(supplierItemPrices.id))
    .limit(6);

  const best = alternatives[0];
  const supplierName = line.rel.displayName;
  const supplierNameAr = line.rel.displayNameAr ?? line.rel.displayName;
  const itemName = line.item.name;
  const itemNameAr = line.item.nameAr ?? line.item.name;
  const realPct = current.minus(oldP).div(oldP).mul(100).toNumber();

  const evidence = {
    item: { id: line.item.id, code: line.item.code, name: itemName, nameAr: itemNameAr, baseUnit: line.item.baseUnit },
    supplier: { id: line.rel.id, name: supplierName, nameAr: supplierNameAr, channel: line.rel.orderChannel, email: line.rel.contactEmail, phone: line.rel.contactPhone },
    supplierItemId: line.si.id,
    pack: { name: line.pack.name, nameAr: line.pack.nameAr },
    previousPrice: money(oldP.toString()),
    newPrice: money(current.toString()),
    changePct: Number(pct1(realPct)),
    costPerUnit: { unit: u.en, unitAr: u.ar, previous: money(costOld.mul(u.f).toString()), current: money(costNew.mul(u.f).toString()) },
    isPreferred: line.si.isPreferred,
    alternatives: alternatives.map((a) => ({
      supplierItemId: a.id,
      supplierId: a.supplierId,
      supplier: a.supplierName,
      supplierAr: a.supplierNameAr ?? a.supplierName,
      item: a.itemName,
      itemAr: a.itemNameAr ?? a.itemName,
      pack: a.packName,
      price: money(a.price),
      costPerUnit: money(new Decimal(a.costPerBase).mul(u.f).toString()),
      savingPct: Number(pct1(a.savingPct)),
    })),
    history: history.map((h) => ({ price: money(h.price), at: h.at.toISOString().slice(0, 10), source: h.source })),
  };

  const template = (): TaskText => {
    const t = `${itemName}: ${supplierName} raised the price ${pct1(realPct)}%`;
    const ta = `${itemNameAr}: رفع ${supplierNameAr} السعر ${pct1(realPct)}٪`;
    const alt = best
      ? ` ${best.supplierName} sells it for SAR ${evidence.alternatives[0]!.costPerUnit} per ${u.en}, ${pct1(best.savingPct)}% less.`
      : ' No cheaper supplier for this item is in your catalogue yet.';
    const altAr = best
      ? ` يبيعه ${best.supplierNameAr ?? best.supplierName} بسعر ${evidence.alternatives[0]!.costPerUnit} ر.س لكل ${u.ar}، أقل بنسبة ${pct1(best.savingPct)}٪.`
      : ' لا يوجد مورد أرخص لهذا الصنف في قائمتك بعد.';
    return {
      title: t,
      title_ar: ta,
      summary: `${supplierName} now charges SAR ${money(current.toString())} for ${line.pack.name}, up from SAR ${money(oldP.toString())} (SAR ${evidence.costPerUnit.current} per ${u.en} vs SAR ${evidence.costPerUnit.previous}).${alt}`,
      summary_ar: `يتقاضى ${supplierNameAr} الآن ${money(current.toString())} ر.س مقابل ${line.pack.nameAr ?? line.pack.name}، بعد أن كان ${money(oldP.toString())} ر.س (${evidence.costPerUnit.current} ر.س لكل ${u.ar} مقارنة بـ ${evidence.costPerUnit.previous} ر.س).${altAr}`,
      message: `Hello ${supplierName} team, we noticed the price of ${itemName} (${line.pack.name}) changed from SAR ${money(oldP.toString())} to SAR ${money(current.toString())}. Could you confirm the reason for the increase, or let us know if you can keep the previous price? Thank you.`,
      message_ar: `مرحبًا فريق ${supplierNameAr}، لاحظنا أن سعر ${itemNameAr} (${line.pack.nameAr ?? line.pack.name}) تغيّر من ${money(oldP.toString())} ر.س إلى ${money(current.toString())} ر.س. نرجو توضيح سبب الزيادة، أو إفادتنا إن كان بالإمكان الإبقاء على السعر السابق. شكرًا لكم.`,
    };
  };

  const written = await ctx.llm.write(
    'A supplier raised a price. Write the task headline and summary for the restaurant purchasing manager, and a message to the supplier. Mention the cheapest alternative if there is one.',
    evidence,
    template,
  );
  ctx.usage.inputTokens += written.inputTokens;
  ctx.usage.outputTokens += written.outputTokens;
  ctx.usage.costUsd += written.costUsd;
  if (written.model) ctx.usage.model = written.model;
  const text = written.text;

  const actions: Omit<AgentAction, 'autonomy'>[] = [];
  if (best) {
    actions.push({
      id: 'switch',
      type: 'switch_preferred',
      label: `Make ${best.supplierName} the preferred supplier (${pct1(best.savingPct)}% less per ${u.en})`,
      labelAr: `اجعل ${best.supplierNameAr ?? best.supplierName} المورد المفضّل (أقل ${pct1(best.savingPct)}٪ لكل ${u.ar})`,
      params: { supplierItemId: best.id, fromSupplierItemId: line.si.id, savingPct: Number(pct1(best.savingPct)) },
    });
  }
  const email = line.rel.contactEmail;
  const phone = line.rel.contactPhone;
  if (email || phone) {
    actions.push({
      id: 'contact',
      type: 'contact_supplier',
      label: `Ask ${supplierName} about the increase`,
      labelAr: `اسأل ${supplierNameAr} عن الزيادة`,
      params: { supplierId: line.rel.id, channel: line.rel.orderChannel, email, phone, message: text.message, messageAr: text.message_ar },
    });
  }
  actions.push({ id: 'accept', type: 'accept_price', label: 'Accept the new price', labelAr: 'اقبل السعر الجديد', params: {} });

  return {
    kind: 'price_rise',
    subjectKey: `price:${line.si.id}`,
    priority: realPct >= 15 ? 1 : 2,
    title: text.title,
    titleAr: text.title_ar,
    summary: text.summary,
    summaryAr: text.summary_ar,
    evidence,
    actions,
    sourceEventId: rise.eventId,
    writtenBy: written.writtenBy,
  };
}

export const priceWatch: AgentDefinition = {
  kind: 'price_watch',
  name: 'Price Watch',
  nameAr: 'مراقب الأسعار',
  description: 'Catches supplier price rises, finds cheaper suppliers for the same ingredient, and drafts a message to the supplier.',
  descriptionAr: 'يرصد ارتفاع أسعار الموردين، ويجد موردين أرخص لنفس المكوّن، ويصيغ رسالة للمورد.',
  roleKey: 'agent_price_watch',
  subscribes: ['price.changed'],
  defaultSettings: { minIncreasePct: 5, minSavingPctForAuto: 8, scanDays: 30 },
  actionTypes: [
    { type: 'switch_preferred', label: 'Switch preferred supplier', labelAr: 'تغيير المورد المفضّل', allowed: ['suggest', 'approve', 'auto'], default: 'approve', requires: 'price:manage' },
    // Messages are prepared for a person to send until direct messaging ships (Phase B), so no auto.
    { type: 'contact_supplier', label: 'Message the supplier', labelAr: 'مراسلة المورد', allowed: ['suggest', 'approve'], default: 'approve', requires: 'supplier:read' },
    { type: 'accept_price', label: 'Accept the new price', labelAr: 'قبول السعر الجديد', allowed: ['approve'], default: 'approve', requires: 'price:read' },
  ],

  async handleEvents(ctx, evts: EventRow[]) {
    // Keep only the latest event per supplier line; site-specific overrides are ignored for now.
    const latest = new Map<string, PriceRise>();
    for (const e of evts) {
      const p = e.payload as Record<string, string | null>;
      if (e.type !== 'price.changed' || p.siteId || !p.previousPrice || !p.supplierItemId) continue;
      latest.set(p.supplierItemId, { supplierItemId: p.supplierItemId, price: p.price!, previousPrice: p.previousPrice, at: e.occurredAt.toISOString(), eventId: e.id });
    }
    const out: TaskProposal[] = [];
    for (const rise of latest.values()) {
      const proposal = await buildProposal(ctx, rise);
      if (proposal) out.push(proposal);
    }
    return out;
  },

  async scan(ctx) {
    // Look back over recorded price history (e.g. right after the agent is hired).
    const days = Number(ctx.settings.scanDays ?? 30);
    const rows = await ctx.tx
      .select({ supplierItemId: supplierItemPrices.supplierItemId, price: supplierItemPrices.price, previousPrice: supplierItemPrices.previousPrice, at: supplierItemPrices.effectiveFrom })
      .from(supplierItemPrices)
      .where(and(isNotNull(supplierItemPrices.previousPrice), isNull(supplierItemPrices.siteId), gte(supplierItemPrices.effectiveFrom, new Date(Date.now() - days * 86_400_000))))
      .orderBy(desc(supplierItemPrices.id));
    // Compare the current price with the price before the first change in the window.
    const earliest = new Map<string, PriceRise>();
    for (const r of rows) earliest.set(r.supplierItemId, { supplierItemId: r.supplierItemId, price: r.price, previousPrice: r.previousPrice!, at: r.at.toISOString() });
    const out: TaskProposal[] = [];
    for (const rise of earliest.values()) {
      const proposal = await buildProposal(ctx, rise);
      if (proposal) out.push(proposal);
    }
    return out;
  },

  async guardrail(action: AgentAction, ctx: ExecuteContext) {
    if (action.type !== 'switch_preferred') return null;
    const p = action.params as { supplierItemId: string; fromSupplierItemId: string; savingPct: number };
    const [target] = await ctx.tx
      .select({ si: supplierItems, relActive: tradingRelationships.isActive, itemActive: items.isActive, canonicalId: items.canonicalId, baseUnit: items.baseUnit })
      .from(supplierItems)
      .innerJoin(tradingRelationships, eq(tradingRelationships.id, supplierItems.relationshipId))
      .innerJoin(items, eq(items.id, supplierItems.itemId))
      .where(eq(supplierItems.id, p.supplierItemId));
    if (!target || !target.si.isActive || !target.relActive || !target.itemActive) return 'The alternative supplier line is no longer active';
    const [from] = await ctx.tx
      .select({ itemId: supplierItems.itemId, canonicalId: items.canonicalId, baseUnit: items.baseUnit })
      .from(supplierItems)
      .innerJoin(items, eq(items.id, supplierItems.itemId))
      .where(eq(supplierItems.id, p.fromSupplierItemId));
    if (!from) return 'The original supplier line no longer exists';
    const same = target.si.itemId === from.itemId || (from.canonicalId !== null && target.canonicalId === from.canonicalId);
    if (!same || target.baseUnit !== from.baseUnit) return 'The alternative is not the same ingredient';
    // Running without a person needs a meaningful saving.
    if (ctx.automatic) {
      const min = Number(ctx.settings.minSavingPctForAuto ?? 8);
      if (Number(p.savingPct) < min) return `Saving ${p.savingPct}% is below the ${min}% needed to switch automatically`;
    }
    return null;
  },

  async execute(action: AgentAction, ctx: ExecuteContext) {
    const { tx, access } = ctx;
    if (action.type === 'switch_preferred') {
      const p = action.params as { supplierItemId: string; fromSupplierItemId: string };
      return switchPreferred(tx, access, p.supplierItemId, p.fromSupplierItemId);
    }
    if (action.type === 'contact_supplier') {
      const p = action.params as { email?: string | null; phone?: string | null; message: string; messageAr: string; channel: string };
      const body = `${p.messageAr}\n\n${p.message}`;
      return {
        prepared: true,
        mailto: p.email ? `mailto:${p.email}?subject=${encodeURIComponent('Price change / تغيير السعر')}&body=${encodeURIComponent(body)}` : null,
        whatsapp: p.phone ? `https://wa.me/${p.phone.replace(/\D/g, '')}?text=${encodeURIComponent(body)}` : null,
        note: 'Message prepared for sending. Direct sending arrives with WhatsApp/email channels.',
      };
    }
    if (action.type === 'accept_price') return { accepted: true };
    throw new Error(`Unknown action ${action.type}`);
  },
};

async function switchPreferred(tx: Tx, access: ExecuteContext['access'], toId: string, fromId: string) {
  const affected = await tx.select().from(supplierItems).where(inArray(supplierItems.id, [toId, fromId]));
  const target = affected.find((a) => a.id === toId)!;
  const before = await tx.select({ id: supplierItems.id, isPreferred: supplierItems.isPreferred }).from(supplierItems).where(and(eq(supplierItems.itemId, target.itemId), eq(supplierItems.isPreferred, true)));
  await tx.update(supplierItems).set({ isPreferred: false }).where(and(eq(supplierItems.itemId, target.itemId), ne(supplierItems.id, toId)));
  await tx.update(supplierItems).set({ isPreferred: false }).where(eq(supplierItems.id, fromId));
  const [after] = await tx.update(supplierItems).set({ isPreferred: true }).where(eq(supplierItems.id, toId)).returning();
  await audit(tx, access, { action: 'supplier_item.preferred_set', entityType: 'supplier_item', entityId: toId, before: { preferred: before.map((b) => b.id) }, after: { preferred: [toId], via: 'agent' } });
  return { preferredSupplierItemId: after!.id, previousPreferred: before.map((b) => b.id) };
}
