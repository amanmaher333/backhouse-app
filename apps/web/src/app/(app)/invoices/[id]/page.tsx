'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Dialog, Field, PageHead, Toast } from '@/components/ui';
import { InvoiceStatusTag, LinesEditor, toLineInput, useOpenDocument, type EditLine } from '@/components/invoices';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { SupplierRow } from '@/lib/types';
import type { InvoiceDetail } from '@/lib/types-invoices';

const STICKY = ['unknown_sender', 'buyer_vat', 'not_invoice', 'unreadable'];

export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const search = useSearchParams();
  const { t, pick, lang, fmtMoney: fmtOrgMoney, fmtDate } = useI18n();
  const { api } = useSession();
  const openDocument = useOpenDocument();
  const { data: inv, error, reload } = useApi<InvoiceDetail>(`/supplier-invoices/${id}`, [id]);
  const { data: suppliers } = useApi<SupplierRow[]>(inv?.can.manage && !inv.supplier ? '/suppliers' : null, [inv?.can.manage, inv?.supplier?.id]);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ number: string; issueDate: string; dueDate: string; lines: EditLine[] } | null>(null);
  const [dialog, setDialog] = useState<null | 'approve' | 'reject' | 'paid'>(null);
  const [disputed, setDisputed] = useState<{ message: string; links: { mailto: string | null; whatsapp: string | null } } | null>(null);
  const ar = lang === 'ar';

  if (error) return <div className="notice notice-error">{error.message}</div>;
  if (!inv) return <div className="muted">{t('loading')}</div>;
  // Amounts on this page are in the document's own currency.
  const fmtMoney = (v: string | number | null | undefined, d = 2) => fmtOrgMoney(v, d, inv.currency);

  const call = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) setToast(done);
      reload();
      window.dispatchEvent(new Event('boh:inbox-changed'));
      return true;
    } catch (e) {
      setToast((e as ApiError).message);
      return false;
    } finally {
      setBusy(false);
    }
  };
  const patch = (body: Record<string, unknown>) => call(() => api(`/supplier-invoices/${id}`, { method: 'PATCH', body }));

  const typeLabel = t(inv.type === 'credit_note' ? 'creditNote' : inv.type === 'debit_note' ? 'debitNote' : 'invoice');
  const discrepancies = inv.match?.discrepancies ?? [];
  const blocking = discrepancies.filter((d) => d.blocking);
  const info = discrepancies.filter((d) => !d.blocking);
  const matchFor = (i: number) => inv.match?.lines[i];
  const poLine = (poLineId: string | null | undefined) => inv.po?.lines.find((p) => p.id === poLineId);
  const lineFlags = (i: number) => new Set(blocking.filter((d) => d.lineIndex === i).map((d) => d.kind));
  const stickyReasons = inv.reviewReasons.filter((r) => STICKY.includes(r));
  const startEdit = () =>
    setEditing({
      number: inv.number ?? '',
      issueDate: inv.issueDate ?? '',
      dueDate: inv.dueDate ?? '',
      lines: inv.lines.length
        ? inv.lines.map((l) => ({ description: l.description, sku: l.supplierSku ?? '', qty: String(Number(l.qty)), unitPrice: String(Number(l.unitPrice)), poLineId: l.poLineId ?? '' }))
        : (inv.po?.lines ?? []).map((p) => ({ description: pick({ name: p.itemName, nameAr: p.itemNameAr }), sku: p.supplierSku ?? '', qty: String(Number(p.receivedQty) - Number(p.invoicedElsewhere)), unitPrice: String(Number(p.receivedUnitPrice ?? p.unitPrice)), poLineId: p.id })),
    });

  const dispute = () =>
    call(async () => {
      const send = inv.supplier?.orderChannel === 'whatsapp' && !!inv.supplier.contactPhone;
      const r = await api<{ sent: unknown; message: string; links: { mailto: string | null; whatsapp: string | null } }>(`/supplier-invoices/${id}/dispute`, { method: 'POST', body: { send } });
      if (r.sent) setToast(t('sentOnWhatsapp'));
      else setDisputed({ message: r.message, links: r.links });
    });

  return (
    <div className="page">
      <PageHead
        title={`${typeLabel} ${inv.number ?? inv.ref}`}
        sub={[inv.supplier ? pick(inv.supplier) : inv.supplierNameOnInvoice, inv.site ? pick(inv.site) : null, inv.issueDate ? fmtDate(inv.issueDate) : null, inv.dueDate && inv.type === 'invoice' ? `${t('dueDate')} ${fmtDate(inv.dueDate)}` : null]
          .filter(Boolean)
          .join(' · ')}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <span className="tag">{t(`by_${inv.extractedBy}` as TKey)}</span>
            {inv.source === 'email' && <span className="tag">{t('source_email')}</span>}
            <InvoiceStatusTag status={inv.status} />
          </div>
        }
      />

      {search.get('dup') && <div className="notice notice-info">{t('alreadyUploaded')}</div>}

      {inv.status === 'needs_review' && inv.reviewReasons.length > 0 && (
        <section className="card" style={{ gap: 10 }}>
          {inv.reviewReasons.map((r) => (
            <div key={r} className="notice">
              {t(`rr_${r}` as TKey)}
              {r === 'unknown_sender' && inv.emailFrom && (
                <>
                  {' '}
                  <bdi className="faint">{inv.emailFrom}</bdi>
                </>
              )}
            </div>
          ))}
          {inv.can.manage && !inv.supplier && suppliers && (
            <Field label={t('supplier')}>
              <select className="select" defaultValue="" onChange={(e) => e.target.value && patch({ relationshipId: e.target.value })} disabled={busy}>
                <option value="">{t('pickSupplier')}</option>
                {suppliers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {pick({ name: s.displayName, nameAr: s.displayNameAr })}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {inv.can.manage && inv.candidates.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                {t('waitingDeliveries')}
              </div>
              {inv.candidates.map((c) => (
                <div key={c.id} className="row-line">
                  <span className="grow num" style={{ fontWeight: 500 }}>
                    {c.number} · {pick({ name: c.siteName, nameAr: c.siteNameAr })}
                    {c.deliveryDate ? ` · ${fmtDate(c.deliveryDate)}` : ''}
                  </span>
                  <span className="num faint">
                    {fmtMoney(c.unbilled)} {t('unbilled')}
                  </span>
                  <button className="btn btn-sm btn-primary" disabled={busy} onClick={() => patch({ poId: c.id })}>
                    {t('link')}
                  </button>
                </div>
              ))}
            </div>
          )}
          {inv.can.manage && stickyReasons.length > 0 && (
            <div>
              <button className="btn btn-sm btn-quiet" disabled={busy} onClick={() => patch({ acknowledge: true })}>
                {t('confirmChecked')}
              </button>
            </div>
          )}
        </section>
      )}

      {/* The reader's own remarks (what to check); "couldn't read" is already said by the review reasons. */}
      {inv.extraction?.note && inv.extractedBy === 'claude' && !['approved', 'paid'].includes(inv.status) && <div className="notice">{inv.extraction.note}</div>}
      {inv.approvedOverride && (
        <div className="notice">
          <strong>{t('approvedAnyway')}:</strong> {inv.approvedOverride}
        </div>
      )}
      {inv.rejectReason && (
        <div className="notice notice-error">
          <strong>{t('rejected')}:</strong> {inv.rejectReason}
        </div>
      )}

      {inv.match && inv.type === 'invoice' && inv.po && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('matchTitle')}</h2>
            <Link href={`/orders/${inv.po.id}`} className="btn btn-sm btn-quiet num">
              {t('order')} {inv.po.number}
            </Link>
          </div>
          {blocking.length === 0 ? (
            <div className="notice notice-info">{t('matchClean')}</div>
          ) : (
            <>
              <ul className="diff-list" aria-label={t('differences')}>
                {blocking.map((d, i) => (
                  <li key={i}>
                    <span>{ar ? d.messageAr : d.message}</span>
                    {Number(d.amount) > 0 && <span className="amount num">{fmtMoney(d.amount)}</span>}
                  </li>
                ))}
              </ul>
              {Number(inv.claimTotal) > 0 && (
                <div className="totals">
                  <strong>{t('claim')}</strong>
                  <strong className="num cell-flag">{fmtMoney(inv.claimTotal)}</strong>
                </div>
              )}
            </>
          )}
          {info.length > 0 && (
            <ul className="diff-list" aria-label={t('notes')} style={{ marginTop: 8 }}>
              {info.map((d, i) => (
                <li key={i} className="info">
                  <span>{ar ? d.messageAr : d.message}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section className="card">
        {editing ? (
          <>
            <div className="form-grid">
              <Field label={t('invoiceNo')}>
                <input className="input" dir="ltr" value={editing.number} onChange={(e) => setEditing({ ...editing, number: e.target.value })} />
              </Field>
              <Field label={t('issueDate')}>
                <input className="input" type="date" value={editing.issueDate} onChange={(e) => setEditing({ ...editing, issueDate: e.target.value })} />
              </Field>
              <Field label={t('dueDate')} hint={t('optional')}>
                <input className="input" type="date" value={editing.dueDate} onChange={(e) => setEditing({ ...editing, dueDate: e.target.value })} />
              </Field>
            </div>
            <LinesEditor lines={editing.lines} onChange={(lines) => setEditing({ ...editing, lines })} poLines={inv.po?.lines} />
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                className="btn btn-primary"
                disabled={busy}
                onClick={async () => {
                  const ok = await patch({
                    number: editing.number.trim() || null,
                    issueDate: editing.issueDate || null,
                    ...(editing.dueDate ? { dueDate: editing.dueDate } : {}),
                    lines: editing.lines.map(toLineInput),
                    acknowledge: stickyReasons.includes('unreadable') || undefined,
                  });
                  if (ok) setEditing(null);
                }}
              >
                {t('saveChanges')}
              </button>
              <button className="btn btn-quiet" onClick={() => setEditing(null)}>
                {t('cancel')}
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('description')}</th>
                    <th className="end">{t('qty')}</th>
                    <th className="end">{t('unitPrice')}</th>
                    {inv.po && <th className="end hide-phone">{t('received')}</th>}
                    <th className="end">{t('lineTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {inv.lines.map((l, i) => {
                    const m = matchFor(i);
                    const p = poLine(m?.poLineId);
                    const flags = lineFlags(i);
                    return (
                      <tr key={l.id}>
                        <td>
                          <div style={{ fontWeight: 500 }}>
                            <bdi>{l.description}</bdi>
                          </div>
                          <div className="faint" style={{ fontSize: 12 }}>
                            {l.supplierSku && (
                              <>
                                <bdi className="nowrap">{l.supplierSku}</bdi>
                                {inv.po ? ' · ' : ''}
                              </>
                            )}
                            {inv.po && inv.type === 'invoice' && (p ? `${t('pairedWith')}: ${pick({ name: p.itemName, nameAr: p.itemNameAr })}` : <span className="cell-flag">{t('notPaired')}</span>)}
                          </div>
                        </td>
                        <td className={`end num ${flags.has('qty_not_received') ? 'cell-flag' : ''}`}>{Number(l.qty)}</td>
                        <td className="end num">
                          <span className={flags.has('price_higher') ? 'cell-flag' : ''}>{fmtMoney(l.unitPrice)}</span>
                          {m?.expectedPrice && Number(m.expectedPrice) !== Number(l.unitPrice) && (
                            <div className="faint" style={{ fontSize: 12 }}>
                              {t('agreed')} {fmtMoney(m.expectedPrice)}
                            </div>
                          )}
                        </td>
                        {inv.po && <td className="end num hide-phone">{m?.billableQty !== null && m?.billableQty !== undefined ? Number(m.billableQty) : '–'}</td>}
                        <td className={`end num ${flags.has('line_total') ? 'cell-flag' : ''}`}>{fmtMoney(l.lineTotal)}</td>
                      </tr>
                    );
                  })}
                  {inv.lines.length === 0 && (
                    <tr>
                      <td colSpan={5} className="faint">
                        –
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="totals">
              <span className="muted">{t('subtotal')}</span>
              <span className="num">{inv.subtotal ? fmtMoney(inv.subtotal) : '–'}</span>
              <span className="muted">{t('vat')}</span>
              <span className="num">{inv.taxTotal ? fmtMoney(inv.taxTotal) : '–'}</span>
              <strong>{t('total')}</strong>
              <strong className="num">{inv.total ? fmtMoney(inv.total) : '–'}</strong>
            </div>
          </>
        )}

        {!editing && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {inv.can.approve && inv.status === 'matched' && (
              <button className="btn btn-primary" disabled={busy} onClick={() => call(() => api(`/supplier-invoices/${id}/approve`, { method: 'POST', body: {} }))}>
                {inv.type === 'invoice' ? t('approveForPayment') : t('approve')}
              </button>
            )}
            {inv.can.dispute && inv.status === 'mismatch' && inv.supplier && (
              <button className="btn btn-primary" disabled={busy} onClick={dispute}>
                {t('askCreditNote')}
              </button>
            )}
            {inv.can.approve && inv.status !== 'matched' && inv.supplier && (
              <button className="btn btn-quiet" disabled={busy} onClick={() => setDialog('approve')}>
                {t('approveAnyway')}
              </button>
            )}
            {inv.can.pay && (
              <button className="btn btn-primary" disabled={busy} onClick={() => setDialog('paid')}>
                {t('markPaid')}
              </button>
            )}
            {inv.can.manage && (
              <button className="btn btn-quiet" disabled={busy} onClick={startEdit}>
                {t('edit')}
              </button>
            )}
            {inv.can.manage && (
              <button className="btn btn-quiet" disabled={busy} onClick={() => call(() => api(`/supplier-invoices/${id}/match`, { method: 'POST' }))}>
                {t('reMatch')}
              </button>
            )}
            {inv.document && (
              <button className="btn btn-quiet" onClick={() => openDocument(inv.id).catch((e) => setToast((e as Error).message))}>
                {t('viewOriginal')}
              </button>
            )}
            <span style={{ flex: 1 }} />
            {inv.can.approve && !['approved', 'paid', 'rejected'].includes(inv.status) && (
              <button className="btn btn-quiet" disabled={busy} onClick={() => setDialog('reject')}>
                {t('rejectInvoice')}
              </button>
            )}
          </div>
        )}
      </section>

      {inv.disputeMessage && inv.status === 'disputed' && (
        <section className="card">
          <h2 className="card-title">{t('askCreditNote')}</h2>
          <Message text={inv.disputeMessage} />
        </section>
      )}

      {(inv.creditNotes.length > 0 || inv.corrects) && (
        <section className="card">
          <h2 className="card-title">{inv.corrects ? t('corrects') : t('creditNotes')}</h2>
          {[...(inv.corrects ? [inv.corrects] : []), ...inv.creditNotes].map((c) => (
            <div key={c.id} className="row-line">
              <Link href={`/invoices/${c.id}`} className="grow num" style={{ fontWeight: 500 }}>
                <bdi>{c.number ?? c.ref}</bdi>
              </Link>
              <span className="num">{c.total ? fmtMoney(c.total) : '–'}</span>
              <InvoiceStatusTag status={c.status} />
            </div>
          ))}
        </section>
      )}

      {dialog === 'approve' && <ReasonDialog title={t('approveAnyway')} label={t('approveReason')} onClose={() => setDialog(null)} onSubmit={(reason) => call(() => api(`/supplier-invoices/${id}/approve`, { method: 'POST', body: { reason } })).then((ok) => ok && setDialog(null))} />}
      {dialog === 'reject' && <ReasonDialog title={t('rejectInvoice')} label={t('rejectReason')} onClose={() => setDialog(null)} onSubmit={(reason) => call(() => api(`/supplier-invoices/${id}/reject`, { method: 'POST', body: { reason } })).then((ok) => ok && setDialog(null))} />}
      {dialog === 'paid' && <PaidDialog onClose={() => setDialog(null)} onSubmit={(body) => call(() => api(`/supplier-invoices/${id}/paid`, { method: 'POST', body })).then((ok) => ok && setDialog(null))} />}
      {disputed && (
        <Dialog
          title={t('askCreditNote')}
          onClose={() => setDisputed(null)}
          actions={
            <>
              {disputed.links.whatsapp && (
                <a className="btn btn-quiet" href={disputed.links.whatsapp} target="_blank" rel="noopener noreferrer">
                  {t('openWhatsapp')}
                </a>
              )}
              {disputed.links.mailto && (
                <a className="btn btn-primary" href={disputed.links.mailto} target="_blank" rel="noopener noreferrer">
                  {t('openEmail')}
                </a>
              )}
            </>
          }
        >
          <div className="notice">{t('creditNoteAsked')}</div>
          <div style={{ maxHeight: 320, overflow: 'auto' }}>
            <Message text={disputed.message} />
          </div>
        </Dialog>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/** A bilingual message (Arabic, blank line, English): each part in its own direction. */
function Message({ text }: { text: string }) {
  return (
    <div style={{ display: 'grid', gap: 10 }}>
      {text.split('\n\n').map((part, i) => (
        <blockquote key={i} className="message-draft" dir="auto" style={{ whiteSpace: 'pre-line', margin: 0 }}>
          {part}
        </blockquote>
      ))}
    </div>
  );
}

function ReasonDialog({ title, label, onClose, onSubmit }: { title: string; label: string; onClose: () => void; onSubmit: (reason: string) => void }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={reason.trim().length < 2} onClick={() => onSubmit(reason.trim())}>
            {title}
          </button>
        </>
      }
    >
      <Field label={label}>
        <textarea className="input" rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
      </Field>
    </Dialog>
  );
}

function PaidDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (body: { paidOn: string; reference: string | null }) => void }) {
  const { t } = useI18n();
  const [paidOn, setPaidOn] = useState(new Date().toISOString().slice(0, 10));
  const [reference, setReference] = useState('');
  return (
    <Dialog
      title={t('markPaid')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => onSubmit({ paidOn, reference: reference.trim() || null })}>
            {t('markPaid')}
          </button>
        </>
      }
    >
      <Field label={t('paidOn')}>
        <input className="input" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
      </Field>
      <Field label={t('paymentRef')} hint={t('optional')}>
        <input className="input" dir="ltr" value={reference} onChange={(e) => setReference(e.target.value)} />
      </Field>
    </Dialog>
  );
}
