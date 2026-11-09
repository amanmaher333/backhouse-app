import { and, eq, inArray } from 'drizzle-orm';
import { purchaseOrders, sites, supplierInvoices, tradingRelationships, type AgentAction } from '@boh/db';
import { Decimal } from '@boh/domain';
import type { TaskText } from './llm.js';
import type { AgentDefinition, EventRow, ExecuteContext, RunContext, TaskProposal } from './types.js';

/**
 * Invoice: never pay for what didn't arrive.
 *
 * Code reads and matches each supplier invoice against its order and the
 * deliveries received (see the invoices service). The agent turns the result
 * into decisions: approve a clean match for payment, ask the supplier for a
 * credit note when it differs, point out what a person must check, and offer
 * to approve once the credit note arrives.
 */

type Inv = typeof supplierInvoices.$inferSelect;
interface Discrepancy { kind: string; message: string; messageAr: string; amount: string; blocking: boolean }

const money = (v: Decimal.Value | null | undefined) => new Decimal(v ?? 0).toFixed(2);
const ltr = (v: string | null | undefined) => `⁦${v ?? '—'}⁩`;

const REASONS: Record<string, [string, string]> = {
  unknown_supplier: ['the supplier is not recognised', 'لم يُتعرّف على المورد'],
  no_order: ['no purchase order was found', 'لم يُعثر على أمر الشراء'],
  unreadable: ['the document could not be read', 'تعذّرت قراءة المستند'],
  not_invoice: ['it may not be an invoice', 'قد لا يكون فاتورة'],
  unknown_sender: ['it came from an email address not on the supplier’s list', 'وصلت من بريد غير مسجل لدى المورد'],
  buyer_vat: ['it is addressed to another VAT number', 'موجهة إلى رقم ضريبي آخر'],
};

async function context(ctx: RunContext | ExecuteContext, inv: Inv) {
  const [rel] = inv.relationshipId ? await ctx.tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, inv.relationshipId)) : [];
  const [site] = inv.siteId ? await ctx.tx.select().from(sites).where(eq(sites.id, inv.siteId)) : [];
  const [po] = inv.poId ? await ctx.tx.select({ number: purchaseOrders.number }).from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId)) : [];
  const sup = rel?.displayName ?? inv.supplierNameOnInvoice ?? 'Unknown supplier';
  const supAr = rel?.displayNameAr ?? rel?.displayName ?? inv.supplierNameOnInvoice ?? 'مورد غير معروف';
  return { rel, site, po, sup, supAr, no: inv.number ?? inv.ref };
}

function evidenceOf(inv: Inv, c: Awaited<ReturnType<typeof context>>, discrepancies: Discrepancy[]) {
  return {
    invoiceId: inv.id,
    ref: inv.ref,
    number: inv.number,
    type: inv.type,
    status: inv.status,
    issueDate: inv.issueDate,
    dueDate: inv.dueDate,
    subtotal: inv.subtotal,
    taxTotal: inv.taxTotal,
    total: inv.total,
    claimTotal: inv.claimTotal,
    source: inv.source,
    extractedBy: inv.extractedBy,
    reviewReasons: inv.reviewReasons,
    supplier: c.rel ? { id: c.rel.id, name: c.sup, nameAr: c.supAr } : { id: null, name: c.sup, nameAr: c.supAr },
    site: c.site ? { id: c.site.id, name: c.site.name, nameAr: c.site.nameAr } : null,
    poNumber: c.po?.number ?? null,
    discrepancies: discrepancies.map((d) => ({ kind: d.kind, message: d.message, messageAr: d.messageAr, amount: d.amount })),
  };
}

function track(ctx: RunContext, w: { inputTokens: number; outputTokens: number; costUsd: number; model: string | null }) {
  ctx.usage.inputTokens += w.inputTokens;
  ctx.usage.outputTokens += w.outputTokens;
  ctx.usage.costUsd += w.costUsd;
  if (w.model) ctx.usage.model = w.model;
}

async function proposalFor(ctx: RunContext, inv: Inv, creditNote?: Inv): Promise<TaskProposal | null> {
  const c = await context(ctx, inv);
  const match = (inv.match ?? {}) as { discrepancies?: Discrepancy[] };
  const blocking = (match.discrepancies ?? []).filter((d) => d.blocking);
  const evidence = evidenceOf(inv, c, blocking);
  const base = { subjectKey: `invoice:${inv.id}`, evidence } as const;
  const approve = (reason: string | null, label: string, labelAr: string): Omit<AgentAction, 'autonomy'> => ({
    id: reason ? 'approve_anyway' : 'approve',
    type: 'approve_invoice',
    label,
    labelAr,
    params: { invoiceId: inv.id, expectStatus: inv.status, total: inv.total, reason },
  });

  // A credit note arrived for an invoice we disputed.
  if (inv.status === 'disputed' && creditNote) {
    const covers = new Decimal(creditNote.total ?? 0).abs().gte(new Decimal(inv.claimTotal).minus(1));
    return {
      ...base,
      kind: 'invoice_credit_note',
      priority: 2,
      title: `${c.sup} sent credit note ${creditNote.number ?? creditNote.ref} (SAR ${money(creditNote.total)}) for invoice ${c.no}`,
      titleAr: `${c.supAr} أرسل إشعارًا دائنًا ${ltr(creditNote.number ?? creditNote.ref)} (${money(creditNote.total)} ر.س) للفاتورة ${ltr(c.no)}`,
      summary: covers
        ? `It covers the SAR ${money(inv.claimTotal)} we asked for. The invoice can now be approved for payment, less the credit note.`
        : `We asked for SAR ${money(inv.claimTotal)}; the credit note is for SAR ${money(creditNote.total)}. Check before approving.`,
      summaryAr: covers
        ? `يغطي مبلغ ${money(inv.claimTotal)} ر.س الذي طلبناه. يمكن الآن اعتماد الفاتورة للدفع بعد خصم الإشعار الدائن.`
        : `طلبنا ${money(inv.claimTotal)} ر.س، والإشعار الدائن بمبلغ ${money(creditNote.total)} ر.س. راجع قبل الاعتماد.`,
      evidence: { ...evidence, creditNote: { id: creditNote.id, ref: creditNote.ref, number: creditNote.number, total: creditNote.total }, covers },
      actions: [
        approve(
          `Credit note ${creditNote.number ?? creditNote.ref} (SAR ${money(creditNote.total)}) received`,
          `Approve invoice ${c.no} with the credit note`,
          `اعتمد الفاتورة ${ltr(c.no)} مع الإشعار الدائن`,
        ),
      ],
      writtenBy: 'template',
    };
  }

  if (inv.status === 'matched') {
    const isCredit = inv.type !== 'invoice';
    return {
      ...base,
      kind: 'invoice_approve',
      priority: 3,
      title: isCredit
        ? `Credit note ${c.no} from ${c.sup}: SAR ${money(inv.total)}`
        : `Approve invoice ${c.no} from ${c.sup}: SAR ${money(inv.total)}`,
      titleAr: isCredit
        ? `إشعار دائن ${ltr(c.no)} من ${c.supAr}: ${money(inv.total)} ر.س`
        : `اعتماد الفاتورة ${ltr(c.no)} من ${c.supAr}: ${money(inv.total)} ر.س`,
      summary: isCredit
        ? `The credit note adds up. Accept it to record it against the supplier's account.`
        : `It matches order ${c.po?.number ?? '—'} and what was received${c.site ? ` at ${c.site.name}` : ''}: prices, quantities and VAT. Due ${inv.dueDate ?? 'on receipt'}.`,
      summaryAr: isCredit
        ? 'الإشعار الدائن سليم حسابيًا. اقبله لتسجيله في حساب المورد.'
        : `تطابق أمر الشراء ${ltr(c.po?.number)} والكميات المستلمة${c.site ? ` في ${c.site.nameAr ?? c.site.name}` : ''}: الأسعار والكميات والضريبة. تاريخ الاستحقاق ${ltr(inv.dueDate)}.`,
      actions: [approve(null, isCredit ? 'Accept the credit note' : `Approve for payment (SAR ${money(inv.total)})`, isCredit ? 'اقبل الإشعار الدائن' : `اعتمد للدفع (${money(inv.total)} ر.س)`)],
      writtenBy: 'template',
    };
  }

  if (inv.status === 'mismatch') {
    const claim = new Decimal(inv.claimTotal);
    const tpl = ctx.services.invoices.disputeMessage({ number: inv.number, ref: inv.ref, poNumber: c.po?.number ?? null, supplierName: c.sup, supplierNameAr: c.supAr, discrepancies: blocking, claimTotal: inv.claimTotal });
    const first = blocking[0];
    const template = (): TaskText => ({
      title: claim.gt(0) ? `Invoice ${c.no} from ${c.sup} is SAR ${money(claim)} more than it should be` : `Invoice ${c.no} from ${c.sup} doesn't match`,
      title_ar: claim.gt(0) ? `الفاتورة ${ltr(c.no)} من ${c.supAr} تزيد ${money(claim)} ر.س عن المستحق` : `الفاتورة ${ltr(c.no)} من ${c.supAr} غير مطابقة`,
      summary: `${blocking.slice(0, 3).map((d) => d.message).join('; ')}${blocking.length > 3 ? `; and ${blocking.length - 3} more` : ''}.`,
      summary_ar: `${blocking.slice(0, 3).map((d) => d.messageAr).join('؛ ')}${blocking.length > 3 ? `؛ و${blocking.length - 3} أخرى` : ''}.`,
      message: tpl.en,
      message_ar: tpl.ar,
    });
    const written = await ctx.llm.write(
      'A supplier invoice does not match the purchase order and the goods received. Write the task headline and summary for the restaurant finance team (what differs and the amount to claim back), and a message to the supplier listing the differences and asking for a credit note or a corrected invoice.',
      evidence,
      template,
    );
    track(ctx, written);
    const canDispute = Boolean(c.rel) && blocking.some((d) => d.kind !== 'duplicate');
    return {
      ...base,
      kind: 'invoice_dispute',
      priority: first?.kind === 'duplicate' ? 1 : claim.gt(0) ? 1 : 2,
      title: written.text.title,
      titleAr: written.text.title_ar,
      summary: written.text.summary,
      summaryAr: written.text.summary_ar,
      actions: [
        ...(canDispute
          ? [
              {
                id: 'credit_note',
                type: 'request_credit_note',
                label: claim.gt(0) ? `Ask ${c.sup} for a credit note (SAR ${money(claim)})` : `Ask ${c.sup} to correct the invoice`,
                labelAr: claim.gt(0) ? `اطلب من ${c.supAr} إشعارًا دائنًا (${money(claim)} ر.س)` : `اطلب من ${c.supAr} تصحيح الفاتورة`,
                params: { invoiceId: inv.id, claimTotal: inv.claimTotal, message: written.text.message || tpl.en, messageAr: written.text.message_ar || tpl.ar },
              },
            ]
          : []),
        approve(`Approved as billed from the inbox (${blocking.map((d) => d.kind).join(', ')})`, 'Approve as billed', 'اعتمد كما هي'),
      ],
      writtenBy: written.writtenBy,
    };
  }

  if (inv.status === 'needs_review') {
    const reasons = inv.reviewReasons.map((r) => REASONS[r] ?? [r, r]);
    return {
      ...base,
      kind: 'invoice_review',
      priority: 2,
      title: `Check invoice ${c.no}${c.rel ? ` from ${c.sup}` : ''}`,
      titleAr: `راجع الفاتورة ${ltr(c.no)}${c.rel ? ` من ${c.supAr}` : ''}`,
      summary: `It can't be matched automatically: ${reasons.map((r) => r[0]).join('; ') || 'it needs a purchase order'}.`,
      summaryAr: `لا يمكن مطابقتها تلقائيًا: ${reasons.map((r) => r[1]).join('؛ ') || 'تحتاج إلى أمر شراء'}.`,
      actions: [],
      writtenBy: 'template',
    };
  }
  return null;
}

async function proposalsFor(ctx: RunContext, ids: string[]) {
  if (!ids.length) return { proposals: [], expirePrefixes: [] };
  const invs = await ctx.tx.select().from(supplierInvoices).where(inArray(supplierInvoices.id, ids));
  const credits = await ctx.tx
    .select()
    .from(supplierInvoices)
    .where(and(inArray(supplierInvoices.correctsInvoiceId, ids), inArray(supplierInvoices.status, ['matched', 'approved'])));
  const proposals: TaskProposal[] = [];
  for (const inv of invs) {
    const p = await proposalFor(ctx, inv, credits.find((c) => c.correctsInvoiceId === inv.id));
    if (p) proposals.push(p);
  }
  // Every invoice looked at is re-decided: tasks for invoices no longer needing one expire.
  return { proposals, expirePrefixes: ids.map((id) => `invoice:${id}`) };
}

export const invoice: AgentDefinition = {
  kind: 'invoice',
  name: 'Invoice',
  nameAr: 'الفواتير',
  description: 'Matches every supplier invoice to its order and what was received, approves clean ones for payment, and asks suppliers for credit notes when they overcharge.',
  descriptionAr: 'يطابق كل فاتورة مورد مع أمر الشراء والكميات المستلمة، ويعتمد السليمة للدفع، ويطلب من الموردين إشعارات دائنة عند زيادة المبالغ.',
  roleKey: 'agent_invoice',
  subscribes: ['invoice.received', 'invoice.updated', 'invoice.approved', 'invoice.disputed', 'invoice.rejected', 'invoice.paid', 'invoice.credit_note_received'],
  defaultSettings: { maxAutoApproveSar: 5000 },
  actionTypes: [
    { type: 'approve_invoice', label: 'Approve invoices for payment', labelAr: 'اعتماد الفواتير للدفع', allowed: ['suggest', 'approve', 'auto'], default: 'approve', requires: 'invoice:approve' },
    { type: 'request_credit_note', label: 'Ask suppliers for credit notes', labelAr: 'طلب إشعارات دائنة من الموردين', allowed: ['suggest', 'approve'], default: 'approve', requires: 'invoice:approve' },
  ],

  async handleEvents(ctx, evts: EventRow[]) {
    const ids = new Set<string>();
    for (const e of evts) {
      const p = e.payload as { invoiceId?: string };
      if (p.invoiceId) ids.add(p.invoiceId);
    }
    return proposalsFor(ctx, [...ids]);
  },

  async scan(ctx) {
    const open = await ctx.tx
      .select({ id: supplierInvoices.id })
      .from(supplierInvoices)
      .where(inArray(supplierInvoices.status, ['needs_review', 'matched', 'mismatch', 'disputed']))
      .limit(300);
    return proposalsFor(ctx, open.map((o) => o.id));
  },

  async guardrail(action: AgentAction, ctx: ExecuteContext) {
    const p = action.params as { invoiceId: string; expectStatus?: string; total?: string };
    const [inv] = await ctx.tx.select().from(supplierInvoices).where(eq(supplierInvoices.id, p.invoiceId));
    if (!inv) return 'The invoice no longer exists';
    if (action.type === 'approve_invoice') {
      if (p.expectStatus && inv.status !== p.expectStatus) return `The invoice is now ${inv.status}`;
      if (inv.total !== (p.total ?? inv.total)) return 'The invoice changed after this suggestion';
      if (ctx.automatic) {
        if (inv.status !== 'matched') return 'Only invoices that match are approved without a person';
        if (inv.reviewReasons.length) return 'The invoice needs a person to check it';
        if (inv.type !== 'invoice') return 'Credit notes are accepted by a person';
        const max = Number(ctx.settings.maxAutoApproveSar ?? 5000);
        if (new Decimal(inv.total ?? 0).gt(max)) return `Invoice total SAR ${money(inv.total)} is above the SAR ${money(max)} allowed without approval`;
      }
    }
    if (action.type === 'request_credit_note' && !['mismatch', 'needs_review', 'matched'].includes(inv.status)) return `The invoice is now ${inv.status}`;
    return null;
  },

  async execute(action: AgentAction, ctx: ExecuteContext) {
    const p = action.params as { invoiceId: string; reason?: string | null; message?: string; messageAr?: string };
    if (action.type === 'approve_invoice') {
      const inv = await ctx.services.invoices.approveInTx(ctx.tx, ctx.access, p.invoiceId, { reason: p.reason ?? null, approver: ctx.approver });
      return { invoiceId: inv.id, ref: inv.ref, status: inv.status, total: inv.total, override: inv.approvedOverride };
    }
    if (action.type === 'request_credit_note') {
      const r = await ctx.services.invoices.disputeInTx(ctx.tx, ctx.access, p.invoiceId, { message: p.message, messageAr: p.messageAr, send: true, approver: ctx.approver });
      return r.sent ? { sentDirect: true, to: r.sent.to, messageId: r.sent.messageId } : { prepared: true, mailto: r.links.mailto, whatsapp: r.links.whatsapp };
    }
    throw new Error(`Unknown action ${action.type}`);
  },
};
