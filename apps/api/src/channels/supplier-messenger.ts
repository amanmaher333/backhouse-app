import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Injectable, Module, NotFoundException, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { createHash, randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull } from 'drizzle-orm';
import {
  inboundMessages,
  items,
  memberships,
  organizations,
  outboundMessages,
  packs,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  supplierItems,
  supplierOrderLinks,
  tradingRelationships,
  userChannels,
  users,
  type Tx,
} from '@boh/db';
import { clip, normalizePhone, supplierPayload, templateParam, WA_LIMITS } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService } from '../common/db.service.js';
import { AccessContext } from '../common/access.js';
import { loadGrants } from '../common/grants.js';
import { audit, auditRaw } from '../common/audit.js';
import { Public } from '../common/auth.js';
import { emitEvent } from '../agents/events.js';
import type { MessageContent } from './transport.js';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const LINK_TTL_DAYS = 45;
const NOTE_WINDOW_MIN = 120;
/** A supplier's free text is attached to their latest order sent from BOH within this many days. */
const THREAD_DAYS = 30;
const NOTIFY_MAX = 5;

/** Statuses in which a supplier's confirmation still means something. */
const CONFIRMABLE = ['sent', 'partially_received', 'approved'];

type QueueInput = { orgId: string | null; userId: string | null; to: string; kind: string; content: MessageContent; relationshipId?: string | null; poId?: string | null; taskId?: string | null };

/** Queue an outbound WhatsApp message (the worker sends it). Works in tenant and system transactions. */
export async function queueOutbound(tx: Tx, m: QueueInput): Promise<string> {
  const [row] = await tx
    .insert(outboundMessages)
    .values({
      orgId: m.orgId,
      userId: m.userId,
      channel: 'whatsapp',
      toAddress: m.to,
      kind: m.kind,
      taskId: m.taskId ?? null,
      relationshipId: m.relationshipId ?? null,
      poId: m.poId ?? null,
      content: m.content as unknown as Record<string, unknown>,
    })
    .returning({ id: outboundMessages.id });
  return row!.id;
}

const bi = (ar: string, en: string) => `${ar}\n${en}`;

export interface OrderToSend {
  id: string;
  orgId: string;
  number: string;
  deliveryDate: string | null;
  total: string;
  site: { name: string; nameAr: string | null };
  supplier: { id: string; contactPhone: string | null; hidePricesOnPo: boolean };
  lines: unknown[];
}

/**
 * Messages between restaurants and their suppliers, sent from BOH's WhatsApp number.
 * Orders go with Confirm / Problem buttons and a private link; replies come back onto the
 * order, and the people who manage that site's orders hear about problems.
 */
@Injectable()
export class SupplierMessenger {
  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  orderUrl(token: string) {
    return `${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/s/${token}`;
  }

  /** The supplier's WhatsApp number, if usable. */
  supplierAddress(phone: string | null | undefined): string | null {
    return phone ? normalizePhone(phone) : null;
  }

  /** Send an order to the supplier's WhatsApp, inside the caller's transaction (the order is marked sent with it). */
  async sendOrder(tx: Tx, a: AccessContext, po: OrderToSend, message: string) {
    const to = this.supplierAddress(po.supplier.contactPhone);
    if (!to) throw new BadRequestException('This supplier has no valid WhatsApp number');
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, a.orgId));
    const token = randomBytes(24).toString('base64url');
    const [link] = await tx
      .insert(supplierOrderLinks)
      .values({ orgId: a.orgId, poId: po.id, relationshipId: po.supplier.id, toAddress: to, tokenHash: sha256(token), expiresAt: new Date(Date.now() + LINK_TTL_DAYS * 86400_000) })
      .returning();
    const url = this.orderUrl(token);
    const tail = bi(`للتأكيد أو الإبلاغ عن مشكلة استخدم الأزرار، أو افتح الطلب: ${url}`, `Use the buttons to confirm or report a problem, or open the order: ${url}`);
    const orgName = org?.nameAr ?? org?.name ?? '';
    const count = po.lines.length;
    const summary = po.supplier.hidePricesOnPo
      ? `${count} ${count === 1 ? 'صنف' : 'أصناف'}`
      : `${count} ${count === 1 ? 'صنف' : 'أصناف'} · ${Number(po.total).toFixed(2)} ر.س شامل الضريبة`;
    const content: MessageContent = {
      lang: 'ar',
      text: `${clip(message, WA_LIMITS.body - tail.length - 2)}\n\n${tail}`,
      footer: clip(`BOH · ${orgName}`, 60),
      buttons: [
        { id: supplierPayload(link!.id, 'confirm'), title: 'تأكيد / Confirm' },
        { id: supplierPayload(link!.id, 'problem'), title: 'مشكلة / Problem' },
      ],
      template: {
        name: this.config.WHATSAPP_TEMPLATE_SUPPLIER_ORDER,
        bodyParams: [templateParam(orgName, 100), templateParam(po.number, 30), templateParam(po.site.nameAr ?? po.site.name, 100), templateParam(po.deliveryDate ?? '-', 20), templateParam(summary, 200)],
        quickReplyPayloads: [supplierPayload(link!.id, 'confirm'), supplierPayload(link!.id, 'problem')],
        urlSuffix: token,
      },
    };
    const messageId = await queueOutbound(tx, { orgId: a.orgId, userId: null, to, kind: 'supplier_order', content, relationshipId: po.supplier.id, poId: po.id });
    await audit(tx, a, { action: 'purchase_order.sent_whatsapp', entityType: 'purchase_order', entityId: po.id, after: { to, messageId } });
    return { to, messageId, viewUrl: url };
  }

  /** A follow-up to a supplier (late delivery, price question), after a person approved it. */
  async sendFollowUp(tx: Tx, a: Pick<AccessContext, 'orgId'>, p: { relationshipId: string; poId?: string | null; about: string; message: string; messageAr: string }) {
    const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, p.relationshipId));
    const to = this.supplierAddress(rel?.contactPhone);
    if (!rel || !to) return null;
    const [org] = await tx.select().from(organizations).where(eq(organizations.id, a.orgId));
    const orgName = org?.nameAr ?? org?.name ?? '';
    const content: MessageContent = {
      lang: 'ar',
      text: clip(`${p.messageAr}\n\n${p.message}`, WA_LIMITS.body),
      footer: clip(`BOH · ${orgName}`, 60),
      template: { name: this.config.WHATSAPP_TEMPLATE_SUPPLIER_FOLLOWUP, bodyParams: [templateParam(orgName, 100), templateParam(p.about, 60), templateParam(p.messageAr, 700)], quickReplyPayloads: [] },
    };
    const messageId = await queueOutbound(tx, { orgId: a.orgId, userId: null, to, kind: 'supplier_followup', content, relationshipId: rel.id, poId: p.poId ?? null });
    return { to, messageId };
  }

  // ---------- the supplier's side ----------

  /** The order behind a private link, as the supplier may see it. */
  async orderByToken(token: string) {
    return this.db.system(async (tx) => {
      const link = await this.linkByToken(tx, token);
      const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, link.poId));
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, link.orgId));
      const [site] = await tx.select().from(sites).where(eq(sites.id, po!.siteId));
      const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, link.relationshipId));
      const showPrices = !rel!.hidePricesOnPo;
      const lines = await tx
        .select({
          itemName: items.name,
          itemNameAr: items.nameAr,
          packName: packs.name,
          packNameAr: packs.nameAr,
          supplierSku: supplierItems.supplierSku,
          qty: purchaseOrderLines.qty,
          unitPrice: purchaseOrderLines.unitPrice,
          lineTotal: purchaseOrderLines.lineTotal,
        })
        .from(purchaseOrderLines)
        .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
        .innerJoin(packs, eq(packs.id, purchaseOrderLines.packId))
        .leftJoin(supplierItems, eq(supplierItems.id, purchaseOrderLines.supplierItemId))
        .where(eq(purchaseOrderLines.poId, po!.id))
        .orderBy(asc(purchaseOrderLines.sortOrder));
      return {
        number: po!.number,
        status: po!.status,
        deliveryDate: po!.deliveryDate,
        notes: po!.notes,
        restaurant: { name: org!.name, nameAr: org!.nameAr },
        site: { name: site!.name, nameAr: site!.nameAr, address: site!.address },
        supplier: { name: rel!.displayName, nameAr: rel!.displayNameAr },
        lines: lines.map((l) => ({ ...l, unitPrice: showPrices ? l.unitPrice : null, lineTotal: showPrices ? l.lineTotal : null })),
        totals: showPrices ? { subtotal: po!.subtotal, tax: po!.taxTotal, total: po!.total } : null,
        confirmedAt: po!.supplierConfirmedAt,
        issue: po!.supplierIssue,
        canAnswer: CONFIRMABLE.includes(po!.status),
      };
    });
  }

  confirmByToken(token: string) {
    return this.db.system(async (tx) => {
      const link = await this.linkByToken(tx, token);
      return this.confirm(tx, link, 'link');
    });
  }

  problemByToken(token: string, text: string) {
    return this.db.system(async (tx) => {
      const link = await this.linkByToken(tx, token);
      return this.problem(tx, link, text, 'link');
    });
  }

  private async linkByToken(tx: Tx, token: string) {
    const [link] = await tx
      .select()
      .from(supplierOrderLinks)
      .where(and(eq(supplierOrderLinks.tokenHash, sha256(token)), gt(supplierOrderLinks.expiresAt, new Date())));
    if (!link) throw new NotFoundException('This link is not valid or has expired');
    return link;
  }

  /** Supplier confirmed: recorded once; later confirmations are acknowledged without changes. */
  async confirm(tx: Tx, link: typeof supplierOrderLinks.$inferSelect, via: 'whatsapp' | 'link') {
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, link.poId)).for('update');
    if (!po) throw new NotFoundException();
    if (!CONFIRMABLE.includes(po.status)) return { outcome: 'not_open' as const, po };
    if (po.supplierConfirmedAt) return { outcome: 'already_confirmed' as const, po };
    const [after] = await tx.update(purchaseOrders).set({ supplierConfirmedAt: new Date(), supplierConfirmedVia: via }).where(eq(purchaseOrders.id, po.id)).returning();
    await this.recordReply(tx, link, po, 'confirmed', null, via);
    return { outcome: 'confirmed' as const, po: after! };
  }

  /** Supplier reported a problem: stored on the order, the restaurant is told, and the Purchasing agent picks it up. */
  async problem(tx: Tx, link: typeof supplierOrderLinks.$inferSelect, text: string, via: 'whatsapp' | 'link') {
    const clean = text.trim().slice(0, 1000);
    if (!clean) throw new BadRequestException('Describe the problem');
    const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, link.poId)).for('update');
    if (!po) throw new NotFoundException();
    const [after] = await tx.update(purchaseOrders).set({ supplierIssue: clean, supplierIssueAt: new Date() }).where(eq(purchaseOrders.id, po.id)).returning();
    await tx.update(supplierOrderLinks).set({ awaitingNoteUntil: null }).where(eq(supplierOrderLinks.id, link.id));
    const notified = await this.recordReply(tx, link, po, 'problem', clean, via);
    return { outcome: 'problem_recorded' as const, po: after!, notified };
  }

  /** Event for agents, audit entry, and WhatsApp notices to the people who manage this site's orders. */
  private async recordReply(tx: Tx, link: typeof supplierOrderLinks.$inferSelect, po: typeof purchaseOrders.$inferSelect, kind: 'confirmed' | 'problem' | 'message', text: string | null, via: string) {
    const actor = { orgId: link.orgId, userId: null, actorType: 'integration' as const };
    await emitEvent(tx, actor, 'po.supplier_replied', { type: 'purchase_order', id: po.id }, { poId: po.id, number: po.number, siteId: po.siteId, relationshipId: link.relationshipId, kind, text, via });
    await auditRaw(tx, { orgId: link.orgId, userId: null, requestId: `supplier:${via}`, action: `purchase_order.supplier_${kind}`, entityType: 'purchase_order', entityId: po.id, after: { text, via } });
    if (kind === 'confirmed') return [];
    return this.notifyRestaurant(tx, link, po, kind, text ?? '');
  }

  private async notifyRestaurant(tx: Tx, link: typeof supplierOrderLinks.$inferSelect, po: typeof purchaseOrders.$inferSelect, kind: 'problem' | 'message', text: string) {
    const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, link.relationshipId));
    const people = await tx
      .select({ user: users, channel: userChannels })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(userChannels, and(eq(userChannels.userId, users.id), eq(userChannels.channel, 'whatsapp')))
      .where(and(eq(memberships.orgId, link.orgId), eq(users.kind, 'human'), eq(users.isActive, true), eq(userChannels.approvalsEnabled, true)));
    const ids: string[] = [];
    for (const { user, channel } of people) {
      if (ids.length >= NOTIFY_MAX) break;
      const access = new AccessContext(link.orgId, user.id, await loadGrants(tx, link.orgId, user.id), 'supplier-notice', undefined);
      if (!access.can('po:manage', po.siteId)) continue;
      const ar = user.locale !== 'en';
      const sup = ar ? (rel?.displayNameAr ?? rel?.displayName ?? '') : (rel?.displayName ?? '');
      const head =
        kind === 'problem'
          ? ar ? `⚠️ *${sup}* أبلغ عن مشكلة في الطلب ${po.number}:` : `⚠️ *${sup}* reported a problem with order ${po.number}:`
          : ar ? `💬 *${sup}* ردّ بخصوص الطلب ${po.number}:` : `💬 *${sup}* replied about order ${po.number}:`;
      const url = `${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/orders/${po.id}`;
      const content: MessageContent = {
        lang: ar ? 'ar' : 'en',
        text: clip(`${head}\n“${text}”\n\n${url}`, WA_LIMITS.body),
        template: { name: this.config.WHATSAPP_TEMPLATE_SUPPLIER_UPDATE, bodyParams: [templateParam(sup, 100), templateParam(po.number, 30), templateParam(text, 700)], quickReplyPayloads: [], urlSuffix: `orders/${po.id}` },
      };
      ids.push(await queueOutbound(tx, { orgId: link.orgId, userId: user.id, to: channel.address, kind: 'supplier_update', content, relationshipId: link.relationshipId, poId: po.id }));
    }
    return ids;
  }

  /**
   * WhatsApp from a supplier number (not a BOH user): a button on an order, or text.
   * Returns null when the number is not a supplier BOH has sent orders to.
   */
  async handleInbound(m: { from: string; inboundId: number; answer?: { linkId: string; answer: 'confirm' | 'problem' }; text?: string }) {
    return this.db.system(async (tx) => {
      let link: typeof supplierOrderLinks.$inferSelect | undefined;
      if (m.answer) {
        [link] = await tx.select().from(supplierOrderLinks).where(eq(supplierOrderLinks.id, m.answer.linkId));
        if (!link || link.toAddress !== m.from) {
          const id = await queueOutbound(tx, { orgId: null, userId: null, to: m.from, kind: 'supplier_ack', content: { lang: 'ar', text: bi('هذا الزر ليس لهذا الرقم.', 'That button is not for this number.') } });
          return { outcome: 'not_yours', ids: [id] };
        }
      } else {
        [link] = await tx
          .select()
          .from(supplierOrderLinks)
          .where(and(eq(supplierOrderLinks.toAddress, m.from), gt(supplierOrderLinks.createdAt, new Date(Date.now() - THREAD_DAYS * 86400_000))))
          .orderBy(desc(supplierOrderLinks.createdAt))
          .limit(1);
        if (!link) return null;
      }
      await tx.update(inboundMessages).set({ orgId: link.orgId, relationshipId: link.relationshipId, poId: link.poId }).where(eq(inboundMessages.id, m.inboundId));
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, link.orgId));
      const orgName = { ar: org?.nameAr ?? org?.name ?? '', en: org?.name ?? '' };
      const ack = (ar: string, en: string) => queueOutbound(tx, { orgId: link!.orgId, userId: null, to: m.from, kind: 'supplier_ack', content: { lang: 'ar', text: bi(ar, en) }, relationshipId: link!.relationshipId, poId: link!.poId });

      if (m.answer?.answer === 'confirm') {
        const r = await this.confirm(tx, link, 'whatsapp');
        const id =
          r.outcome === 'confirmed'
            ? await ack(`✅ شكرًا، تم تأكيد الطلب ${r.po.number}.`, `✅ Thank you, order ${r.po.number} is confirmed.`)
            : r.outcome === 'already_confirmed'
              ? await ack(`الطلب ${r.po.number} مؤكد مسبقًا.`, `Order ${r.po.number} is already confirmed.`)
              : await ack(`الطلب ${r.po.number} لم يعد مفتوحًا.`, `Order ${r.po.number} is no longer open.`);
        return { outcome: r.outcome, ids: [id] };
      }
      if (m.answer?.answer === 'problem') {
        await tx.update(supplierOrderLinks).set({ awaitingNoteUntil: new Date(Date.now() + NOTE_WINDOW_MIN * 60_000) }).where(eq(supplierOrderLinks.id, link.id));
        const id = await ack(
          `اكتب المشكلة في رسالة واحدة (مثل صنف غير متوفر أو موعد مختلف) وسننقلها إلى ${orgName.ar}.`,
          `Please describe the problem in one message (for example an item is unavailable, or a different date) and we will pass it to ${orgName.en}.`,
        );
        return { outcome: 'awaiting_problem', ids: [id] };
      }
      const text = (m.text ?? '').trim();
      if (!text) return { outcome: 'ignored', ids: [] };
      const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, link.poId));
      if (link.awaitingNoteUntil && link.awaitingNoteUntil.getTime() > Date.now()) {
        const r = await this.problem(tx, link, text, 'whatsapp');
        const id = await ack(`شكرًا، أبلغنا ${orgName.ar} بالمشكلة في الطلب ${po!.number}.`, `Thank you, we have told ${orgName.en} about the problem with order ${po!.number}.`);
        return { outcome: 'problem_recorded', ids: [id, ...r.notified] };
      }
      const notified = await this.recordReply(tx, link, po!, 'message', text.slice(0, 1000), 'whatsapp');
      const id = await ack(`شكرًا، وصلت رسالتك إلى ${orgName.ar} (الطلب ${po!.number}).`, `Thank you, your message has been passed to ${orgName.en} (order ${po!.number}).`);
      return { outcome: 'message_relayed', ids: [id, ...notified] };
    });
  }

  /** The WhatsApp conversation with the supplier about one order (for the PO page). */
  conversation(tx: Tx, poId: string) {
    return Promise.all([
      tx
        .select({ id: outboundMessages.id, kind: outboundMessages.kind, status: outboundMessages.status, sentAs: outboundMessages.sentAs, content: outboundMessages.content, at: outboundMessages.createdAt })
        .from(outboundMessages)
        .where(and(eq(outboundMessages.poId, poId), isNull(outboundMessages.userId), inArray(outboundMessages.kind, ['supplier_order', 'supplier_followup', 'supplier_ack']))),
      tx
        .select({ id: inboundMessages.id, type: inboundMessages.type, payload: inboundMessages.payload, at: inboundMessages.receivedAt })
        .from(inboundMessages)
        .where(eq(inboundMessages.poId, poId)),
    ]).then(([out, inn]) =>
      [
        ...out.map((o) => ({ id: o.id, dir: 'to_supplier' as const, kind: o.kind, status: o.status, sentAs: o.sentAs, text: (o.content as { text?: string }).text ?? '', at: o.at })),
        ...inn.map((i) => {
          const p = i.payload as { text?: { body?: string }; interactive?: { button_reply?: { title?: string } }; button?: { text?: string } };
          return { id: String(i.id), dir: 'from_supplier' as const, kind: i.type, status: null, sentAs: null, text: p.text?.body ?? p.interactive?.button_reply?.title ?? p.button?.text ?? '', at: i.at };
        }),
      ].sort((a, b) => a.at.getTime() - b.at.getTime()),
    );
  }
}

const ProblemSchema = z.object({ message: z.string().trim().min(1).max(1000) });
class ProblemDto extends createZodDto(ProblemSchema) {}

/** The supplier's private order page (no account needed; the link is the credential). */
@ApiTags('supplier orders')
@Controller('supplier-orders')
class SupplierOrdersController {
  constructor(private readonly svc: SupplierMessenger) {}

  @Public() @Get(':token')
  get(@Param('token') token: string) { return this.svc.orderByToken(token); }

  @Public() @Post(':token/confirm') @HttpCode(200)
  async confirm(@Param('token') token: string) {
    const r = await this.svc.confirmByToken(token);
    return { outcome: r.outcome };
  }

  @Public() @Post(':token/problem') @HttpCode(200)
  async problem(@Param('token') token: string, @Body() dto: ProblemDto) {
    const r = await this.svc.problemByToken(token, dto.message);
    return { outcome: r.outcome };
  }
}

@Module({ controllers: [SupplierOrdersController], providers: [SupplierMessenger], exports: [SupplierMessenger] })
export class SupplierMessagingModule {}
