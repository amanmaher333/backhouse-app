import { createHash, randomBytes } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, asc, desc, eq, gt, inArray, ne, or, sql } from 'drizzle-orm';
import {
  corrections,
  goodsReceiptLines,
  invoiceDocuments,
  invoiceInboxes,
  items,
  legalEntities,
  orgCounters,
  organizations,
  packs,
  purchaseOrderLines,
  purchaseOrders,
  sites,
  supplierInvoiceLines,
  supplierInvoices,
  supplierItems,
  supplierProfiles,
  tradingRelationships,
  type Tx,
} from '@boh/db';
import {
  Decimal,
  addDays,
  country,
  formatMoney,
  matchInvoice,
  normalizeName,
  type InvoiceDraft,
  type InvoiceLineDraft,
  type MatchPoLine,
  type MatchResult,
} from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { AccessContext } from '../common/access.js';
import { audit, auditRaw, type AuditInput } from '../common/audit.js';
import { emitEvent, type EventType } from '../agents/events.js';
import { SupplierMessenger } from '../channels/supplier-messenger.js';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { ACCEPTED_TYPES, InvoiceExtractor, type ExtractResult } from './extractor.js';

export type InvoiceRow = typeof supplierInvoices.$inferSelect;
type LineRow = typeof supplierInvoiceLines.$inferSelect;

/** People act with an AccessContext; emails arrive with no user. */
export type Actor = AccessContext | { orgId: string; userId: null; actorType: 'integration'; requestId: string };
const isPerson = (a: Actor): a is AccessContext => a instanceof AccessContext;

/** Statuses a person or the matcher can still change. */
const OPEN = ['needs_review', 'matched', 'mismatch'] as const;
const STICKY_REASONS = ['unknown_sender', 'buyer_vat', 'not_invoice', 'unreadable'] as const;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const NIL = '00000000-0000-0000-0000-000000000000';

export interface LineInput {
  description: string;
  sku?: string | null;
  qty: number;
  unit?: string | null;
  unitPrice: number;
  lineTotal?: number | null;
  taxRate?: number | null;
  poLineId?: string | null;
}

export interface IntakeInput {
  draft: InvoiceDraft | null;
  extractedBy: 'xml' | 'claude' | 'manual' | 'none';
  extraction?: Record<string, unknown> | null;
  source: 'manual' | 'upload' | 'email';
  documentId?: string | null;
  emailFrom?: string | null;
  emailSubject?: string | null;
  relationshipId?: string | null;
  siteId?: string | null;
  poId?: string | null;
  stickyReasons?: string[];
}

const money = (v: Decimal.Value) => new Decimal(v).toFixed(2);
const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
/** Keep a left-to-right value in order inside Arabic text. */
const ltr = (v: string | null | undefined) => `⁦${v ?? '—'}⁩`;

@Injectable()
export class InvoicesService {
  constructor(
    private readonly db: DbService,
    private readonly extractor: InvoiceExtractor,
    private readonly messenger: SupplierMessenger,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ---------- helpers ----------

  private async record(tx: Tx, actor: Actor, e: AuditInput) {
    if (isPerson(actor)) return audit(tx, actor, e);
    return auditRaw(tx, { ...e, orgId: actor.orgId, userId: null, requestId: actor.requestId });
  }

  private emit(tx: Tx, actor: Actor, type: EventType, inv: InvoiceRow, extra: Record<string, unknown> = {}) {
    return emitEvent(tx, actor, type, { type: 'supplier_invoice', id: inv.id }, { invoiceId: inv.id, ref: inv.ref, siteId: inv.siteId, relationshipId: inv.relationshipId, poId: inv.poId, status: inv.status, ...extra });
  }

  private async orgCurrency(tx: Tx, orgId: string) {
    const [o] = await tx.select({ c: organizations.defaultCurrency }).from(organizations).where(eq(organizations.id, orgId));
    return o?.c ?? 'SAR';
  }

  /** Standard VAT rate of the organisation's country. */
  private async orgVat(tx: Tx, orgId: string) {
    const [o] = await tx.select({ c: organizations.country }).from(organizations).where(eq(organizations.id, orgId));
    return country(o?.c).vatRate;
  }

  private async nextRef(tx: Tx, orgId: string): Promise<string> {
    const [row] = await tx
      .insert(orgCounters)
      .values({ orgId, key: 'si', value: 1 })
      .onConflictDoUpdate({ target: [orgCounters.orgId, orgCounters.key], set: { value: sql`${orgCounters.value} + 1` } })
      .returning();
    return `SI-${String(row!.value).padStart(5, '0')}`;
  }

  private async load(tx: Tx, id: string): Promise<InvoiceRow> {
    const [inv] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id)).for('update');
    if (!inv) throw new NotFoundException('invoice not found');
    return inv;
  }

  /** Site-scoped: invoices without a site yet are visible org-wide, and to the person who added them. */
  canSee(a: AccessContext, perm: string, inv: Pick<InvoiceRow, 'siteId' | 'createdBy'>): boolean {
    if (inv.siteId) return a.can(perm, inv.siteId);
    return a.holdsOrgWide(perm) || (perm !== 'invoice:approve' && inv.createdBy === a.userId);
  }

  private must(a: AccessContext, perm: string, inv: Pick<InvoiceRow, 'siteId' | 'createdBy'>) {
    if (!this.canSee(a, perm, inv)) throw new ForbiddenException(`Missing permission ${perm} for this invoice`);
  }

  // ---------- intake ----------

  /** Store an uploaded file and read it. Same file twice returns the invoice already made from it. */
  async upload(a: AccessContext, dto: { filename: string; contentType: string; data: string; relationshipId?: string | null; siteId?: string | null; poId?: string | null }) {
    const contentType = dto.contentType.toLowerCase().split(';')[0]!.trim();
    if (!(ACCEPTED_TYPES as readonly string[]).includes(contentType)) throw new BadRequestException('Upload a PDF, a photo (JPEG, PNG, WebP) or an e-invoice XML');
    const data = Buffer.from(dto.data, 'base64');
    if (!data.length) throw new BadRequestException('The file is empty');
    if (data.length > MAX_FILE_BYTES) throw new BadRequestException('Files must be 10 MB or smaller');
    if (dto.siteId && !a.can('invoice:manage', dto.siteId)) throw new ForbiddenException('You cannot add invoices for this site');
    const sha256 = createHash('sha256').update(data).digest('hex');

    const existing = await this.db.tenant(a.tenant, async (tx) => {
      const [doc] = await tx.select({ id: invoiceDocuments.id }).from(invoiceDocuments).where(eq(invoiceDocuments.sha256, sha256)).limit(1);
      if (!doc) return null;
      const [inv] = await tx.select().from(supplierInvoices).where(and(eq(supplierInvoices.documentId, doc.id), ne(supplierInvoices.status, 'rejected'))).limit(1);
      return inv ?? null;
    });
    if (existing) return { ...(await this.detail(a, existing.id)), duplicateUpload: true };

    // Reading may call the model; do it outside the transaction.
    const result = await this.extractor.extract({ contentType, data });
    const inv = await this.db.tenant(a.tenant, async (tx) => {
      const [doc] = await tx
        .insert(invoiceDocuments)
        .values({ orgId: a.orgId, filename: dto.filename.slice(0, 200), contentType, size: data.length, sha256, data: data.toString('base64') })
        .returning({ id: invoiceDocuments.id });
      return this.intakeInTx(tx, a, {
        ...this.fromExtraction(result),
        source: 'upload',
        documentId: doc!.id,
        relationshipId: dto.relationshipId ?? null,
        siteId: dto.siteId ?? null,
        poId: dto.poId ?? null,
      });
    });
    return { ...(await this.detail(a, inv.id)), duplicateUpload: false };
  }

  fromExtraction(r: ExtractResult): Pick<IntakeInput, 'draft' | 'extractedBy' | 'extraction' | 'stickyReasons'> {
    const sticky: string[] = [];
    if (!r.draft) sticky.push(r.extractedBy === 'claude' ? 'not_invoice' : 'unreadable');
    return {
      draft: r.draft,
      extractedBy: r.extractedBy,
      extraction: { note: r.note, confidence: r.confidence ?? null, draft: r.draft, usage: r.usage ?? null, raw: r.raw ?? null },
      stickyReasons: sticky,
    };
  }

  /** An invoice typed in by a person. */
  createManual(a: AccessContext, dto: { type: 'invoice' | 'credit_note' | 'debit_note'; relationshipId: string; siteId?: string | null; poId?: string | null; number: string; issueDate: string; dueDate?: string | null; subtotal?: number | null; taxTotal?: number | null; total?: number | null; lines: LineInput[] }) {
    if (dto.siteId && !a.can('invoice:manage', dto.siteId)) throw new ForbiddenException('You cannot add invoices for this site');
    return this.db.tenant(a.tenant, async (tx) => {
      const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, dto.relationshipId));
      if (!rel) throw new NotFoundException('supplier not found');
      const lines = this.lineDrafts(dto.lines);
      const totals = this.totals(lines, rel.taxRate, dto);
      const inv = await this.intakeInTx(tx, a, {
        draft: { type: dto.type, number: dto.number, issueDate: dto.issueDate, dueDate: dto.dueDate ?? null, currency: rel.currency, supplier: {}, buyer: {}, lines, ...totals },
        extractedBy: 'manual',
        source: 'manual',
        relationshipId: rel.id,
        siteId: dto.siteId ?? null,
        poId: dto.poId ?? null,
      });
      // Pairings chosen by the person.
      if (dto.lines.some((l) => l.poLineId)) {
        const rows = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id)).orderBy(asc(supplierInvoiceLines.lineNo));
        for (const [i, l] of dto.lines.entries()) if (l.poLineId && rows[i]) await tx.update(supplierInvoiceLines).set({ poLineId: l.poLineId }).where(eq(supplierInvoiceLines.id, rows[i]!.id));
        await this.matchInTx(tx, a, await this.load(tx, inv.id));
      }
      return this.detailInTx(tx, a, inv.id);
    });
  }

  private lineDrafts(lines: LineInput[]): InvoiceLineDraft[] {
    return lines.map((l) => ({
      description: l.description.trim(),
      sku: l.sku?.trim() || null,
      qty: new Decimal(l.qty).toString(),
      unit: l.unit?.trim() || null,
      unitPrice: new Decimal(l.unitPrice).toString(),
      lineTotal: (l.lineTotal ?? null) !== null ? new Decimal(l.lineTotal!).toFixed(2) : new Decimal(l.qty).mul(l.unitPrice).toFixed(2),
      taxRate: l.taxRate === null || l.taxRate === undefined ? null : new Decimal(l.taxRate).toString(),
    }));
  }

  /** Totals as given, filling in what's missing from the lines and the supplier's VAT rate. */
  private totals(lines: InvoiceLineDraft[], taxRate: Decimal.Value, given: { subtotal?: number | string | null; taxTotal?: number | string | null; total?: number | string | null }) {
    const sum = lines.reduce((s, l) => s.plus(l.lineTotal), new Decimal(0));
    const subtotal = given.subtotal !== null && given.subtotal !== undefined ? new Decimal(given.subtotal) : sum;
    const tax = given.taxTotal !== null && given.taxTotal !== undefined ? new Decimal(given.taxTotal) : subtotal.mul(taxRate).toDecimalPlaces(2);
    const total = given.total !== null && given.total !== undefined ? new Decimal(given.total) : subtotal.plus(tax);
    return { subtotal: money(subtotal), taxTotal: money(tax), total: money(total) };
  }

  /**
   * Create an invoice from what was read, work out the supplier and the order,
   * and match it. Runs in the caller's tenant transaction.
   */
  async intakeInTx(tx: Tx, actor: Actor, input: IntakeInput): Promise<InvoiceRow> {
    const d = input.draft;
    const sticky = new Set(input.stickyReasons ?? []);

    // Supplier: as given, else by VAT number, else by the email sender, else by name.
    let rel = input.relationshipId ? (await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, input.relationshipId)))[0] : undefined;
    if (input.relationshipId && !rel) throw new NotFoundException('supplier not found');
    if (!rel && d?.supplier.vatNumber) {
      [rel] = await tx
        .select({ r: tradingRelationships })
        .from(tradingRelationships)
        .innerJoin(supplierProfiles, eq(supplierProfiles.id, tradingRelationships.supplierProfileId))
        .where(eq(supplierProfiles.vatNumber, d.supplier.vatNumber))
        .limit(1)
        .then((r) => r.map((x) => x.r));
    }
    const fromSender = input.emailFrom ? await this.relationshipForSender(tx, input.emailFrom) : null;
    if (input.emailFrom && !fromSender) sticky.add('unknown_sender');
    if (!rel && fromSender) rel = fromSender;
    if (!rel && d?.supplier.name) rel = await this.relationshipByName(tx, d.supplier.name);

    // Order: as given, else the order number printed on the invoice, else the only open delivery to bill.
    let po = input.poId ? (await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, input.poId)))[0] : undefined;
    if (input.poId && !po) throw new NotFoundException('purchase order not found');
    if (!po && d?.type === 'invoice' && d.orderReference) po = await this.poByReference(tx, d.orderReference, rel?.id ?? null);
    if (!po && rel && d?.type === 'invoice') {
      const candidates = await this.candidatePos(tx, rel.id, null);
      const sub = d.subtotal ? new Decimal(d.subtotal) : null;
      const close = sub ? candidates.filter((c) => new Decimal(c.unbilled).minus(sub).abs().lte(Decimal.max(sub.mul(0.02), 1))) : [];
      const pick = candidates.length === 1 ? candidates[0] : close.length === 1 ? close[0] : undefined;
      if (pick) po = (await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, pick.id)))[0];
    }
    if (po && rel && po.relationshipId !== rel.id) {
      if (input.poId) throw new BadRequestException('That order is with a different supplier');
      po = undefined;
    }
    if (po && !rel) rel = (await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, po.relationshipId)))[0];

    // Addressed to one of our companies?
    if (d?.buyer.vatNumber) {
      const ours = await tx.select({ vat: legalEntities.vatNumber }).from(legalEntities);
      if (ours.some((l) => l.vat) && !ours.some((l) => digits(l.vat) === digits(d.buyer.vatNumber))) sticky.add('buyer_vat');
    }

    // Credit notes: the invoice they correct.
    let corrects: InvoiceRow | undefined;
    if (d && d.type !== 'invoice' && d.billingReference && rel) {
      [corrects] = await tx
        .select()
        .from(supplierInvoices)
        .where(and(eq(supplierInvoices.relationshipId, rel.id), eq(supplierInvoices.number, d.billingReference), eq(supplierInvoices.type, 'invoice')))
        .limit(1);
    }

    const issueDate = d?.issueDate ?? null;
    const dueDate = d?.dueDate ?? (issueDate && rel ? addDays(issueDate, rel.paymentTermsDays) : null);
    const [inv] = await tx
      .insert(supplierInvoices)
      .values({
        orgId: actor.orgId,
        ref: await this.nextRef(tx, actor.orgId),
        type: d?.type ?? 'invoice',
        relationshipId: rel?.id ?? null,
        siteId: po?.siteId ?? input.siteId ?? null,
        poId: po?.id ?? null,
        correctsInvoiceId: corrects?.id ?? null,
        number: d?.number || null,
        zatcaUuid: d?.uuid ?? null,
        issueDate,
        dueDate,
        currency: d?.currency || rel?.currency || (await this.orgCurrency(tx, actor.orgId)),
        subtotal: d?.subtotal ? money(d.subtotal) : null,
        taxTotal: d?.taxTotal ? money(d.taxTotal) : null,
        total: d?.total ? money(d.total) : null,
        supplierVat: d?.supplier.vatNumber ?? null,
        supplierNameOnInvoice: d?.supplier.name ?? null,
        buyerVat: d?.buyer.vatNumber ?? null,
        orderReference: d?.orderReference ?? null,
        billingReference: d?.billingReference ?? null,
        source: input.source,
        extractedBy: input.extractedBy,
        documentId: input.documentId ?? null,
        emailFrom: input.emailFrom ?? null,
        emailSubject: input.emailSubject?.slice(0, 300) ?? null,
        extraction: input.extraction ?? null,
        reviewReasons: [...sticky],
        createdBy: isPerson(actor) ? actor.userId : null,
      })
      .returning();
    if (d?.lines.length) {
      await tx.insert(supplierInvoiceLines).values(
        d.lines.map((l, i) => ({
          orgId: actor.orgId,
          invoiceId: inv!.id,
          lineNo: i + 1,
          description: l.description.slice(0, 500) || '—',
          supplierSku: l.sku ?? null,
          qty: new Decimal(l.qty).toFixed(3),
          unit: l.unit ?? null,
          unitPrice: new Decimal(l.unitPrice).toFixed(4),
          lineTotal: new Decimal(l.lineTotal).toFixed(2),
          taxRate: l.taxRate ?? null,
        })),
      );
    }
    const matched = await this.matchInTx(tx, actor, inv!, { emit: false });
    await this.record(tx, actor, { action: 'supplier_invoice.received', entityType: 'supplier_invoice', entityId: inv!.id, after: { ref: inv!.ref, number: inv!.number, source: input.source, extractedBy: input.extractedBy, status: matched.status, total: inv!.total } });
    await this.emit(tx, actor, 'invoice.received', matched);
    if (corrects) await this.emit(tx, actor, 'invoice.credit_note_received', corrects, { creditNoteId: inv!.id, creditNoteRef: inv!.ref, creditTotal: inv!.total });
    return matched;
  }

  /** A supplier contact whose email (or domain) matches the sender. */
  async relationshipForSender(tx: Tx, from: string) {
    const email = (from.match(/<([^>]+)>/)?.[1] ?? from).trim().toLowerCase();
    const domain = email.split('@')[1] ?? '';
    const rows = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.isActive, true));
    const exact = rows.find((r) => r.contactEmail?.toLowerCase() === email || r.invoiceSenderWhitelist.some((w) => w.toLowerCase() === email));
    if (exact) return exact;
    const byDomain = rows.filter((r) => domain && r.invoiceSenderWhitelist.some((w) => [`@${domain}`, domain].includes(w.toLowerCase())));
    return byDomain.length === 1 ? byDomain[0]! : null;
  }

  private async relationshipByName(tx: Tx, name: string) {
    const key = normalizeName(name).replace(/\b(co|company|est|establishment|llc|ltd|trading|شركه|مؤسسه|للتجاره|التجاريه)\b/g, '').trim();
    if (key.length < 3) return undefined;
    const rows = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.isActive, true));
    const hits = rows.filter((r) => [r.displayName, r.displayNameAr].some((n) => n && (normalizeName(n).includes(key) || key.includes(normalizeName(n)))));
    return hits.length === 1 ? hits[0] : undefined;
  }

  /** "PO-00012", "po 12" and "12" all find PO-00012 (within the supplier when known). */
  private async poByReference(tx: Tx, ref: string, relationshipId: string | null) {
    const n = Number(digits(ref));
    if (!n) return undefined;
    const rows = await tx
      .select()
      .from(purchaseOrders)
      .where(and(relationshipId ? eq(purchaseOrders.relationshipId, relationshipId) : undefined, sql`regexp_replace(${purchaseOrders.number}, '\\D', '', 'g')::bigint = ${n}`));
    return rows.length === 1 ? rows[0] : undefined;
  }

  /** The supplier's orders with goods received and not yet billed in full. */
  async candidatePos(tx: Tx, relationshipId: string, excludeInvoiceId: string | null) {
    const pos = await tx
      .select({ po: purchaseOrders, siteName: sites.name, siteNameAr: sites.nameAr })
      .from(purchaseOrders)
      .innerJoin(sites, eq(sites.id, purchaseOrders.siteId))
      .where(and(eq(purchaseOrders.relationshipId, relationshipId), inArray(purchaseOrders.status, ['sent', 'partially_received', 'received', 'closed']), gt(purchaseOrders.createdAt, new Date(Date.now() - 180 * 86_400_000))))
      .orderBy(desc(purchaseOrders.createdAt))
      .limit(50);
    if (!pos.length) return [];
    const ids = pos.map((p) => p.po.id);
    const received = await tx
      .select({ poLineId: goodsReceiptLines.poLineId, value: sql<string>`sum(${goodsReceiptLines.qty} * ${goodsReceiptLines.unitPrice})::text` })
      .from(goodsReceiptLines)
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, goodsReceiptLines.poLineId))
      .where(inArray(purchaseOrderLines.poId, ids))
      .groupBy(goodsReceiptLines.poLineId);
    const lineToPo = new Map((await tx.select({ id: purchaseOrderLines.id, poId: purchaseOrderLines.poId }).from(purchaseOrderLines).where(inArray(purchaseOrderLines.poId, ids))).map((l) => [l.id, l.poId]));
    const receivedByPo = new Map<string, Decimal>();
    for (const r of received) {
      const poId = lineToPo.get(r.poLineId)!;
      receivedByPo.set(poId, (receivedByPo.get(poId) ?? new Decimal(0)).plus(r.value ?? 0));
    }
    const billed = await tx
      .select({ poId: supplierInvoices.poId, s: sql<string>`coalesce(sum(${supplierInvoices.subtotal}), 0)::text` })
      .from(supplierInvoices)
      .where(and(inArray(supplierInvoices.poId, ids), eq(supplierInvoices.type, 'invoice'), ne(supplierInvoices.status, 'rejected'), excludeInvoiceId ? ne(supplierInvoices.id, excludeInvoiceId) : undefined))
      .groupBy(supplierInvoices.poId);
    const billedBy = new Map(billed.map((b) => [b.poId!, new Decimal(b.s ?? 0)]));
    return pos
      .map((p) => ({
        id: p.po.id,
        number: p.po.number,
        status: p.po.status,
        deliveryDate: p.po.deliveryDate,
        total: p.po.total,
        siteName: p.siteName,
        siteNameAr: p.siteNameAr,
        unbilled: money(Decimal.max((receivedByPo.get(p.po.id) ?? new Decimal(0)).minus(billedBy.get(p.po.id) ?? 0), 0)),
      }))
      .filter((c) => new Decimal(c.unbilled).gt(0));
  }

  // ---------- matching ----------

  /** Order lines with what was received (and at what price) and what other invoices already billed. */
  async poMatchLines(tx: Tx, poId: string, excludeInvoiceId: string): Promise<MatchPoLine[]> {
    const lines = await tx
      .select({ l: purchaseOrderLines, itemName: items.name, itemNameAr: items.nameAr, packName: packs.name, sku: supplierItems.supplierSku, supplierName: supplierItems.supplierName })
      .from(purchaseOrderLines)
      .innerJoin(items, eq(items.id, purchaseOrderLines.itemId))
      .innerJoin(packs, eq(packs.id, purchaseOrderLines.packId))
      .leftJoin(supplierItems, eq(supplierItems.id, purchaseOrderLines.supplierItemId))
      .where(eq(purchaseOrderLines.poId, poId))
      .orderBy(asc(purchaseOrderLines.sortOrder));
    if (!lines.length) return [];
    const receipts = await tx
      .select({ poLineId: goodsReceiptLines.poLineId, qty: sql<string>`sum(${goodsReceiptLines.qty})::text`, value: sql<string>`sum(${goodsReceiptLines.qty} * ${goodsReceiptLines.unitPrice})::text` })
      .from(goodsReceiptLines)
      .where(inArray(goodsReceiptLines.poLineId, lines.map((l) => l.l.id)))
      .groupBy(goodsReceiptLines.poLineId);
    const recBy = new Map(receipts.map((r) => [r.poLineId, r]));
    const billed = await this.billedElsewhere(tx, poId, excludeInvoiceId);
    return lines.map(({ l, itemName, itemNameAr, packName, sku, supplierName }) => {
      const r = recBy.get(l.id);
      const qty = new Decimal(r?.qty ?? 0);
      return {
        id: l.id,
        itemName,
        itemNameAr,
        packName,
        supplierSku: sku,
        supplierName,
        qty: l.qty,
        unitPrice: l.unitPrice,
        receivedQty: l.receivedQty,
        receivedUnitPrice: qty.gt(0) ? new Decimal(r!.value).div(qty).toDecimalPlaces(4).toString() : null,
        invoicedElsewhere: (billed.get(l.id) ?? new Decimal(0)).toString(),
      };
    });
  }

  /** Quantities billed per order line on the order's other live invoices (using each one's pairing). */
  private async billedElsewhere(tx: Tx, poId: string, excludeInvoiceId: string) {
    const others = await tx
      .select({ id: supplierInvoices.id, match: supplierInvoices.match })
      .from(supplierInvoices)
      .where(and(eq(supplierInvoices.poId, poId), ne(supplierInvoices.id, excludeInvoiceId), eq(supplierInvoices.type, 'invoice'), ne(supplierInvoices.status, 'rejected')));
    const out = new Map<string, Decimal>();
    if (!others.length) return out;
    const lines = await tx.select().from(supplierInvoiceLines).where(inArray(supplierInvoiceLines.invoiceId, others.map((o) => o.id))).orderBy(asc(supplierInvoiceLines.lineNo));
    for (const o of others) {
      const pairs = ((o.match as { lines?: { poLineId: string | null }[] } | null)?.lines ?? []);
      lines.filter((l) => l.invoiceId === o.id).forEach((l, i) => {
        const poLineId = l.poLineId ?? pairs[i]?.poLineId;
        if (poLineId) out.set(poLineId, (out.get(poLineId) ?? new Decimal(0)).plus(l.qty));
      });
    }
    return out;
  }

  /** Re-run the three-way match and set the status (for invoices still open). */
  async matchInTx(tx: Tx, actor: Actor, inv: InvoiceRow, opts: { emit?: boolean } = {}): Promise<InvoiceRow> {
    const lines = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id)).orderBy(asc(supplierInvoiceLines.lineNo));
    const [rel] = inv.relationshipId ? await tx.select({ r: tradingRelationships, vat: supplierProfiles.vatNumber }).from(tradingRelationships).innerJoin(supplierProfiles, eq(supplierProfiles.id, tradingRelationships.supplierProfileId)).where(eq(tradingRelationships.id, inv.relationshipId)) : [];
    const [po] = inv.poId ? await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId)) : [];
    const [dup] = inv.relationshipId && inv.number
      ? await tx
          .select({ ref: supplierInvoices.ref })
          .from(supplierInvoices)
          .where(and(eq(supplierInvoices.relationshipId, inv.relationshipId), eq(supplierInvoices.number, inv.number), eq(supplierInvoices.type, inv.type), ne(supplierInvoices.id, inv.id), ne(supplierInvoices.status, 'rejected'), sql`${supplierInvoices.createdAt} < ${inv.createdAt}`))
          .limit(1)
      : [];
    const result: MatchResult = matchInvoice({
      type: inv.type as 'invoice' | 'credit_note' | 'debit_note',
      lines: lines.map((l) => ({ description: l.description, sku: l.supplierSku, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal, taxRate: l.taxRate, poLineId: l.poLineId })),
      subtotal: inv.subtotal,
      taxTotal: inv.taxTotal,
      total: inv.total,
      po: po ? { lines: await this.poMatchLines(tx, po.id, inv.id), taxRate: po.taxRate } : null,
      expectedTaxRate: rel?.r.taxRate ?? po?.taxRate ?? (await this.orgVat(tx, inv.orgId)),
      currency: inv.currency,
      duplicateOf: dup?.ref ?? null,
      supplierVatMismatch: inv.supplierVat && rel?.vat && digits(inv.supplierVat) !== digits(rel.vat) ? { invoice: inv.supplierVat, supplier: rel.vat } : null,
    });

    const reasons = new Set(inv.reviewReasons.filter((r) => (STICKY_REASONS as readonly string[]).includes(r)));
    if (!inv.relationshipId) reasons.add('unknown_supplier');
    if (inv.type === 'invoice' && !inv.poId) reasons.add('no_order');
    if (!lines.length && !inv.total) reasons.add('unreadable');
    const status: InvoiceRow['status'] = !(OPEN as readonly string[]).includes(inv.status)
      ? inv.status
      : reasons.size || result.status === 'no_order'
        ? 'needs_review'
        : result.status === 'matched'
          ? 'matched'
          : 'mismatch';
    const [after] = await tx
      .update(supplierInvoices)
      .set({ match: { ...result, checkedAt: new Date().toISOString() } as unknown as Record<string, unknown>, claimTotal: result.claim.total, status, reviewReasons: [...reasons] })
      .where(eq(supplierInvoices.id, inv.id))
      .returning();
    if (opts.emit) await this.emit(tx, actor, 'invoice.updated', after!);
    return after!;
  }

  rematch(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const inv = await this.load(tx, id);
      this.must(a, 'invoice:manage', inv);
      await this.matchInTx(tx, a, inv, { emit: true });
      return this.detailInTx(tx, a, id);
    });
  }

  // ---------- people's changes ----------

  update(
    a: AccessContext,
    id: string,
    dto: {
      relationshipId?: string | null;
      poId?: string | null;
      siteId?: string | null;
      type?: 'invoice' | 'credit_note' | 'debit_note';
      number?: string | null;
      issueDate?: string | null;
      dueDate?: string | null;
      subtotal?: number | null;
      taxTotal?: number | null;
      total?: number | null;
      lines?: LineInput[];
      acknowledge?: boolean;
    },
  ) {
    return this.db.tenant(a.tenant, async (tx) => {
      const inv = await this.load(tx, id);
      this.must(a, 'invoice:manage', inv);
      if (!(OPEN as readonly string[]).includes(inv.status)) throw new BadRequestException(`A ${inv.status} invoice can't be changed`);
      const set: Partial<typeof supplierInvoices.$inferInsert> = {};
      let relationshipId = inv.relationshipId;
      if (dto.relationshipId !== undefined) {
        if (dto.relationshipId) {
          const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, dto.relationshipId));
          if (!rel) throw new NotFoundException('supplier not found');
        }
        relationshipId = dto.relationshipId;
        set.relationshipId = dto.relationshipId;
        if (inv.poId && dto.poId === undefined) set.poId = null; // an order belongs to one supplier
      }
      if (dto.poId !== undefined) {
        if (dto.poId) {
          const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, dto.poId));
          if (!po) throw new NotFoundException('purchase order not found');
          if (relationshipId && po.relationshipId !== relationshipId) throw new BadRequestException('That order is with a different supplier');
          if (!a.can('invoice:manage', po.siteId)) throw new ForbiddenException('You cannot manage invoices for that site');
          set.poId = po.id;
          set.siteId = po.siteId;
          set.relationshipId = po.relationshipId;
        } else set.poId = null;
        // Pairings referred to the previous order's lines.
        await tx.update(supplierInvoiceLines).set({ poLineId: null }).where(eq(supplierInvoiceLines.invoiceId, inv.id));
      }
      if (dto.siteId !== undefined && set.siteId === undefined) {
        if (dto.siteId && !a.can('invoice:manage', dto.siteId)) throw new ForbiddenException('You cannot manage invoices for that site');
        set.siteId = dto.siteId;
      }
      for (const k of ['type', 'number', 'issueDate', 'dueDate'] as const) if (dto[k] !== undefined) (set as Record<string, unknown>)[k] = dto[k];
      // Due date from the supplier's payment terms, unless printed or given.
      const finalRel = set.relationshipId !== undefined ? set.relationshipId : inv.relationshipId;
      const finalIssue = set.issueDate !== undefined ? set.issueDate : inv.issueDate;
      if (dto.dueDate === undefined && !inv.dueDate && finalRel && finalIssue) {
        const [r] = await tx.select({ days: tradingRelationships.paymentTermsDays }).from(tradingRelationships).where(eq(tradingRelationships.id, finalRel));
        if (r) set.dueDate = addDays(finalIssue, r.days);
      }

      const before = { lines: await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id)).orderBy(asc(supplierInvoiceLines.lineNo)), subtotal: inv.subtotal, taxTotal: inv.taxTotal, total: inv.total };
      if (dto.lines) {
        const drafts = this.lineDrafts(dto.lines);
        await tx.delete(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id));
        if (drafts.length) {
          await tx.insert(supplierInvoiceLines).values(
            drafts.map((l, i) => ({ orgId: a.orgId, invoiceId: inv.id, lineNo: i + 1, description: l.description || '—', supplierSku: l.sku ?? null, qty: new Decimal(l.qty).toFixed(3), unit: l.unit ?? null, unitPrice: new Decimal(l.unitPrice).toFixed(4), lineTotal: new Decimal(l.lineTotal).toFixed(2), taxRate: l.taxRate ?? null, poLineId: dto.lines![i]!.poLineId ?? null })),
          );
        }
      }
      const touchedTotals = dto.lines || dto.subtotal !== undefined || dto.taxTotal !== undefined || dto.total !== undefined;
      if (touchedTotals) {
        const rows = dto.lines ? this.lineDrafts(dto.lines) : before.lines.map((l) => ({ lineTotal: l.lineTotal }) as InvoiceLineDraft);
        const [rel] = relationshipId ? await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, relationshipId)) : [];
        // Totals not given: keep the printed ones unless the lines changed.
        const keep = (k: 'subtotal' | 'taxTotal' | 'total') => (dto[k] !== undefined ? dto[k] : dto.lines ? null : inv[k]);
        Object.assign(set, this.totals(rows, rel?.taxRate ?? (await this.orgVat(tx, a.orgId)), { subtotal: keep('subtotal'), taxTotal: keep('taxTotal'), total: keep('total') }));
      }
      if (dto.acknowledge) set.reviewReasons = [];
      if (Object.keys(set).length) await tx.update(supplierInvoices).set(set).where(eq(supplierInvoices.id, inv.id));

      // What the person corrected in an automatic reading: training data for extraction.
      if (touchedTotals && ['claude', 'xml'].includes(inv.extractedBy)) {
        await tx.insert(corrections).values({
          orgId: a.orgId,
          kind: 'invoice_extraction',
          subjectType: 'supplier_invoice',
          subjectId: inv.id,
          modelOutput: { lines: before.lines.map((l) => ({ description: l.description, qty: l.qty, unitPrice: l.unitPrice, lineTotal: l.lineTotal })), subtotal: before.subtotal, taxTotal: before.taxTotal, total: before.total },
          humanOutput: { lines: dto.lines ?? null, subtotal: set.subtotal ?? null, taxTotal: set.taxTotal ?? null, total: set.total ?? null },
          userId: a.userId,
        });
      }
      await audit(tx, a, { action: 'supplier_invoice.updated', entityType: 'supplier_invoice', entityId: inv.id, before: { relationshipId: inv.relationshipId, poId: inv.poId, status: inv.status }, after: { ...set, lines: dto.lines?.length } });
      await this.matchInTx(tx, a, await this.load(tx, inv.id), { emit: true });
      return this.detailInTx(tx, a, inv.id);
    });
  }

  /**
   * Approve for payment. A match approves as is; anything else needs a reason
   * (recorded on the invoice). You can't approve an invoice you typed in yourself.
   */
  async approveInTx(tx: Tx, a: AccessContext, id: string, opts: { reason?: string | null; approver?: AccessContext } = {}) {
    const inv = await this.load(tx, id);
    const who = opts.approver ?? a;
    this.must(who, 'invoice:approve', inv);
    if (!['matched', 'mismatch', 'needs_review', 'disputed'].includes(inv.status)) throw new BadRequestException(`Invoice is already ${inv.status}`);
    if (!inv.relationshipId) throw new BadRequestException('Choose the supplier first');
    if (inv.status !== 'matched' && !opts.reason?.trim()) throw new BadRequestException('This invoice does not match; give a reason to approve it anyway');
    if (inv.source === 'manual' && inv.createdBy === who.userId && !who.grants.some((g) => g.permissions.includes('*'))) {
      throw new ForbiddenException('Someone else must approve an invoice you entered');
    }
    const [after] = await tx
      .update(supplierInvoices)
      .set({ status: 'approved', approvedAt: new Date(), approvedBy: who.userId, approvedOverride: inv.status === 'matched' ? null : opts.reason!.trim().slice(0, 500) })
      .where(eq(supplierInvoices.id, inv.id))
      .returning();
    await audit(tx, a, { action: 'supplier_invoice.approved', entityType: 'supplier_invoice', entityId: inv.id, before: { status: inv.status }, after: { status: 'approved', override: after!.approvedOverride, approvedBy: who.userId } });
    await this.emit(tx, a, 'invoice.approved', after!);
    return after!;
  }

  approve(a: AccessContext, id: string, reason: string | null) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.approveInTx(tx, a, id, { reason });
      return this.detailInTx(tx, a, id);
    });
  }

  /** The credit-note request for an invoice's differences, Arabic first. */
  disputeMessage(d: { number: string | null; ref: string; poNumber: string | null; supplierName: string; supplierNameAr: string; discrepancies: { message: string; messageAr: string; blocking: boolean }[]; claimTotal: string; currency?: string | null }) {
    const items = d.discrepancies.filter((x) => x.blocking);
    const no = d.number ?? d.ref;
    const ar = [
      `مرحبًا فريق ${d.supplierNameAr}،`,
      `بخصوص فاتورتكم رقم ${ltr(no)}${d.poNumber ? ` لطلبنا ${ltr(d.poNumber)}` : ''}، وجدنا الفروقات التالية:`,
      ...items.map((x) => `• ${x.messageAr}`),
      new Decimal(d.claimTotal).gt(0) ? `نرجو إرسال إشعار دائن بمبلغ ${formatMoney(d.claimTotal, d.currency, 'ar')} شامل الضريبة، أو فاتورة مصححة.` : 'نرجو مراجعة الفاتورة وإرسال نسخة مصححة.',
      'شكرًا لكم.',
    ].join('\n');
    const en = [
      `Hello ${d.supplierName} team,`,
      `About your invoice ${no}${d.poNumber ? ` for our order ${d.poNumber}` : ''}, we found these differences:`,
      ...items.map((x) => `• ${x.message}`),
      new Decimal(d.claimTotal).gt(0) ? `Please send a credit note for ${formatMoney(d.claimTotal, d.currency, 'en')} including VAT, or a corrected invoice.` : 'Please review the invoice and send a corrected copy.',
      'Thank you.',
    ].join('\n');
    return { ar, en };
  }

  /**
   * Ask the supplier for a credit note. With send, suppliers who take orders on WhatsApp
   * get it from Kitchain directly; otherwise a ready-to-send email/WhatsApp message is returned.
   */
  async disputeInTx(tx: Tx, a: AccessContext, id: string, opts: { message?: string | null; messageAr?: string | null; send?: boolean; approver?: AccessContext } = {}) {
    const inv = await this.load(tx, id);
    this.must(opts.approver ?? a, 'invoice:approve', inv);
    if (!['matched', 'mismatch', 'needs_review'].includes(inv.status)) throw new BadRequestException(`A ${inv.status} invoice can't be disputed`);
    if (!inv.relationshipId) throw new BadRequestException('Choose the supplier first');
    const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, inv.relationshipId));
    const [po] = inv.poId ? await tx.select({ number: purchaseOrders.number }).from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId)) : [];
    const match = inv.match as { discrepancies?: { message: string; messageAr: string; blocking: boolean }[] } | null;
    const tpl = this.disputeMessage({ number: inv.number, ref: inv.ref, poNumber: po?.number ?? null, supplierName: rel!.displayName, supplierNameAr: rel!.displayNameAr ?? rel!.displayName, discrepancies: match?.discrepancies ?? [], claimTotal: inv.claimTotal, currency: inv.currency });
    const en = opts.message?.trim() || tpl.en;
    const ar = opts.messageAr?.trim() || (opts.message?.trim() ? '' : tpl.ar);
    const body = [ar, en].filter(Boolean).join('\n\n');
    const [after] = await tx
      .update(supplierInvoices)
      .set({ status: 'disputed', disputedAt: new Date(), disputedBy: (opts.approver ?? a).userId, disputeMessage: body })
      .where(eq(supplierInvoices.id, inv.id))
      .returning();
    let sent: { to: string; messageId: string } | null = null;
    if (opts.send && rel!.orderChannel === 'whatsapp') {
      sent = await this.messenger.sendFollowUp(tx, a, { relationshipId: rel!.id, poId: inv.poId, about: `الفاتورة ${inv.number ?? inv.ref}`, message: en, messageAr: ar || en });
    }
    const subject = `${inv.number ?? inv.ref}: طلب إشعار دائن / Credit note request`;
    const links = {
      mailto: rel!.contactEmail ? `mailto:${rel!.contactEmail}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` : null,
      whatsapp: rel!.contactPhone ? `https://wa.me/${rel!.contactPhone.replace(/\D/g, '')}?text=${encodeURIComponent(body)}` : null,
    };
    await audit(tx, a, { action: 'supplier_invoice.disputed', entityType: 'supplier_invoice', entityId: inv.id, before: { status: inv.status }, after: { status: 'disputed', claimTotal: inv.claimTotal, sentDirect: Boolean(sent) } });
    await this.emit(tx, a, 'invoice.disputed', after!, { claimTotal: inv.claimTotal });
    return { invoice: after!, message: body, links, sent };
  }

  dispute(a: AccessContext, id: string, dto: { message?: string | null; messageAr?: string | null; send?: boolean }) {
    return this.db.tenant(a.tenant, async (tx) => {
      const r = await this.disputeInTx(tx, a, id, dto);
      return { ...r, invoice: await this.detailInTx(tx, a, id) };
    });
  }

  reject(a: AccessContext, id: string, reason: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const inv = await this.load(tx, id);
      this.must(a, 'invoice:approve', inv);
      if (['approved', 'paid', 'rejected'].includes(inv.status)) throw new BadRequestException(`A ${inv.status} invoice can't be rejected`);
      const [after] = await tx.update(supplierInvoices).set({ status: 'rejected', rejectedAt: new Date(), rejectReason: reason.trim().slice(0, 500) }).where(eq(supplierInvoices.id, inv.id)).returning();
      await audit(tx, a, { action: 'supplier_invoice.rejected', entityType: 'supplier_invoice', entityId: inv.id, before: { status: inv.status }, after: { status: 'rejected', reason } });
      await this.emit(tx, a, 'invoice.rejected', after!);
      return this.detailInTx(tx, a, id);
    });
  }

  markPaid(a: AccessContext, id: string, dto: { paidOn?: string | null; reference?: string | null }) {
    return this.db.tenant(a.tenant, async (tx) => {
      const inv = await this.load(tx, id);
      this.must(a, 'invoice:approve', inv);
      if (inv.status !== 'approved') throw new BadRequestException('Only approved invoices can be marked as paid');
      // A date the person picked: noon UTC keeps it on that day in every Gulf and nearby time zone.
      const paidAt = dto.paidOn ? new Date(`${dto.paidOn}T12:00:00Z`) : new Date();
      const [after] = await tx.update(supplierInvoices).set({ status: 'paid', paidAt, paymentReference: dto.reference?.trim() || null }).where(eq(supplierInvoices.id, inv.id)).returning();
      await audit(tx, a, { action: 'supplier_invoice.paid', entityType: 'supplier_invoice', entityId: inv.id, before: { status: inv.status }, after: { status: 'paid', paidAt, reference: after!.paymentReference } });
      await this.emit(tx, a, 'invoice.paid', after!);
      return this.detailInTx(tx, a, id);
    });
  }

  // ---------- reading ----------

  list(a: AccessContext, q: { status: string; siteId?: string; relationshipId?: string; poId?: string; limit: number }) {
    const scope = a.sitesFor('invoice:read');
    const groups: Record<string, InvoiceRow['status'][]> = {
      review: ['needs_review', 'mismatch'],
      open: ['needs_review', 'matched', 'mismatch', 'disputed'],
      to_pay: ['approved'],
    };
    const statuses = groups[q.status] ?? (q.status === 'all' ? null : [q.status as InvoiceRow['status']]);
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({
          id: supplierInvoices.id,
          ref: supplierInvoices.ref,
          type: supplierInvoices.type,
          number: supplierInvoices.number,
          status: supplierInvoices.status,
          issueDate: supplierInvoices.issueDate,
          dueDate: supplierInvoices.dueDate,
          total: supplierInvoices.total,
          claimTotal: supplierInvoices.claimTotal,
          source: supplierInvoices.source,
          extractedBy: supplierInvoices.extractedBy,
          reviewReasons: supplierInvoices.reviewReasons,
          relationshipId: supplierInvoices.relationshipId,
          supplierName: tradingRelationships.displayName,
          supplierNameAr: tradingRelationships.displayNameAr,
          supplierNameOnInvoice: supplierInvoices.supplierNameOnInvoice,
          siteId: supplierInvoices.siteId,
          siteName: sites.name,
          siteNameAr: sites.nameAr,
          poId: supplierInvoices.poId,
          poNumber: purchaseOrders.number,
          createdAt: supplierInvoices.createdAt,
        })
        .from(supplierInvoices)
        .leftJoin(tradingRelationships, eq(tradingRelationships.id, supplierInvoices.relationshipId))
        .leftJoin(sites, eq(sites.id, supplierInvoices.siteId))
        .leftJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.poId))
        .where(
          and(
            statuses ? inArray(supplierInvoices.status, statuses) : undefined,
            q.siteId ? eq(supplierInvoices.siteId, q.siteId) : undefined,
            q.relationshipId ? eq(supplierInvoices.relationshipId, q.relationshipId) : undefined,
            q.poId ? eq(supplierInvoices.poId, q.poId) : undefined,
            scope === 'all'
              ? undefined
              : or(inArray(supplierInvoices.siteId, scope.length ? scope : [NIL]), eq(supplierInvoices.createdBy, a.userId)),
          ),
        )
        .orderBy(desc(supplierInvoices.createdAt))
        .limit(q.limit),
    );
  }

  /** Counts for the sidebar badge and the page tabs. */
  async counts(a: AccessContext) {
    const rows = await this.list(a, { status: 'all', limit: 2000 });
    const by = (s: string[]) => rows.filter((r) => s.includes(r.status)).length;
    return { review: by(['needs_review', 'mismatch']), matched: by(['matched']), disputed: by(['disputed']), toPay: by(['approved']) };
  }

  async detailInTx(tx: Tx, a: AccessContext, id: string) {
    const [inv] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
    if (!inv || !this.canSee(a, 'invoice:read', inv)) throw new NotFoundException('invoice not found');
    const lines: LineRow[] = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, inv.id)).orderBy(asc(supplierInvoiceLines.lineNo));
    const [rel] = inv.relationshipId
      ? await tx.select({ r: tradingRelationships, vat: supplierProfiles.vatNumber }).from(tradingRelationships).innerJoin(supplierProfiles, eq(supplierProfiles.id, tradingRelationships.supplierProfileId)).where(eq(tradingRelationships.id, inv.relationshipId))
      : [];
    const [site] = inv.siteId ? await tx.select().from(sites).where(eq(sites.id, inv.siteId)) : [];
    const [po] = inv.poId ? await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId)) : [];
    const [doc] = inv.documentId
      ? await tx.select({ id: invoiceDocuments.id, filename: invoiceDocuments.filename, contentType: invoiceDocuments.contentType, size: invoiceDocuments.size }).from(invoiceDocuments).where(eq(invoiceDocuments.id, inv.documentId))
      : [];
    const creditNotes = await tx
      .select({ id: supplierInvoices.id, ref: supplierInvoices.ref, number: supplierInvoices.number, total: supplierInvoices.total, status: supplierInvoices.status, issueDate: supplierInvoices.issueDate })
      .from(supplierInvoices)
      .where(eq(supplierInvoices.correctsInvoiceId, inv.id));
    const [corrects] = inv.correctsInvoiceId
      ? await tx.select({ id: supplierInvoices.id, ref: supplierInvoices.ref, number: supplierInvoices.number, total: supplierInvoices.total, status: supplierInvoices.status }).from(supplierInvoices).where(eq(supplierInvoices.id, inv.correctsInvoiceId))
      : [];
    const open = (OPEN as readonly string[]).includes(inv.status);
    const { extraction, ...rest } = inv;
    return {
      ...rest,
      extraction: extraction ? { note: extraction.note ?? null, confidence: extraction.confidence ?? null } : null,
      lines,
      supplier: rel ? { id: rel.r.id, name: rel.r.displayName, nameAr: rel.r.displayNameAr, vatNumber: rel.vat, orderChannel: rel.r.orderChannel, contactEmail: rel.r.contactEmail, contactPhone: rel.r.contactPhone, paymentTermsDays: rel.r.paymentTermsDays } : null,
      site: site ? { id: site.id, name: site.name, nameAr: site.nameAr } : null,
      po: po ? { id: po.id, number: po.number, status: po.status, deliveryDate: po.deliveryDate, total: po.total, lines: await this.poMatchLines(tx, po.id, inv.id) } : null,
      candidates: !po && inv.relationshipId && inv.type === 'invoice' && open ? await this.candidatePos(tx, inv.relationshipId, inv.id) : [],
      document: doc ?? null,
      creditNotes,
      corrects: corrects ?? null,
      can: {
        manage: open && this.canSee(a, 'invoice:manage', inv),
        approve: this.canSee(a, 'invoice:approve', inv) && ['matched', 'mismatch', 'needs_review', 'disputed'].includes(inv.status),
        dispute: this.canSee(a, 'invoice:approve', inv) && open,
        pay: this.canSee(a, 'invoice:approve', inv) && inv.status === 'approved',
      },
    };
  }

  detail(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, (tx) => this.detailInTx(tx, a, id));
  }

  async document(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [inv] = await tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, id));
      if (!inv || !this.canSee(a, 'invoice:read', inv) || !inv.documentId) throw new NotFoundException('document not found');
      const [doc] = await tx.select().from(invoiceDocuments).where(eq(invoiceDocuments.id, inv.documentId));
      if (!doc) throw new NotFoundException('document not found');
      return { filename: doc.filename, contentType: doc.contentType, data: Buffer.from(doc.data, 'base64') };
    });
  }

  // ---------- email address ----------

  inboxAddress(token: string) {
    return `invoices+${token}@${this.config.INBOUND_EMAIL_DOMAIN}`;
  }

  /** The organisation's private address for supplier invoices (created on first use). */
  inbox(a: AccessContext) {
    return this.db.tenant(a.tenant, async (tx) => {
      let [row] = await tx.select().from(invoiceInboxes).where(eq(invoiceInboxes.orgId, a.orgId));
      if (!row) {
        [row] = await tx.insert(invoiceInboxes).values({ orgId: a.orgId, token: randomBytes(6).toString('hex') }).returning();
        await audit(tx, a, { action: 'invoice_inbox.created', entityType: 'invoice_inbox', entityId: a.orgId });
      }
      return { address: this.inboxAddress(row!.token), enabled: Boolean(this.config.INBOUND_EMAIL_SECRET), readsAutomatically: this.extractor.mode === 'claude' };
    });
  }
}
