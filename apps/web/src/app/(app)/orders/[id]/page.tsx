'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArmButton, Dialog, Field, PageHead, Toast } from '@/components/ui';
import { IconBot } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { PoDetail } from '@/lib/types-procurement';
import { PoStatusTag } from '@/components/procurement';
import { InvoiceStatusTag } from '@/components/invoices';
import type { InvoiceRow } from '@/lib/types-invoices';

/** Server reasons are 'English\nArabic'; show the line for the current language. */
function reasonFor(reason: string, lang: string) {
  const [en, ar] = reason.split('\n');
  return lang === 'ar' && ar ? ar : en;
}

export default function OrderPage() {
  const { id } = useParams<{ id: string }>();
  const { t, pick, lang, fmtMoney, fmtDate } = useI18n();
  const { api, me, can } = useSession();
  const { data: po, error, reload } = useApi<PoDetail>(`/purchase-orders/${id}`, [id]);
  const { data: invoices } = useApi<InvoiceRow[]>(can('invoice:read') ? `/supplier-invoices?status=all&poId=${id}` : null, [id]);
  const [toast, setToast] = useState<string | null>(null);
  const [receiving, setReceiving] = useState(false);
  const [sent, setSent] = useState<{ message: string; links: { mailto: string | null; whatsapp: string | null } } | null>(null);
  const [busy, setBusy] = useState(false);

  if (error) return <div className="notice notice-error">{error.message}</div>;
  if (!po) return <div className="muted">{t('loading')}</div>;

  const has = (perm: string) =>
    !!me?.memberships.some((m) => m.permissions.some((p) => p === '*' || p === perm || p === `${perm.split(':')[0]}:*`) && (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(po.siteId)));
  const act = async (path: string, body: Record<string, unknown> = {}) => {
    setBusy(true);
    try {
      const r = await api<any>(`/purchase-orders/${id}/${path}`, { method: 'POST', body });
      if (path === 'send') {
        if (r.direct) setToast(t('sentDirect'));
        else setSent({ message: r.message, links: r.links });
      }
      reload();
    } catch (e) {
      setToast((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const ar = lang === 'ar';

  return (
    <div className="page">
      <PageHead
        title={po.number}
        sub={`${pick(po.supplier)} · ${pick(po.site)}${po.deliveryDate ? ` · ${t('delivery')} ${fmtDate(po.deliveryDate)}` : ''}`}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            {po.source === 'agent' && (
              <span className="tag tag-accent">
                <IconBot width={14} height={14} /> {t('byAgent')}
              </span>
            )}
            <PoStatusTag status={po.status} />
          </div>
        }
      />

      {po.status === 'pending_approval' && po.approvalReason && (
        <div className="notice">
          <strong>{t('needsApproval')}:</strong> {reasonFor(po.approvalReason, lang)}
        </div>
      )}

      <section className="card">
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th className="end">{t('qty')}</th>
                <th className="end hide-phone">{t('unitPrice')}</th>
                <th className="end">{t('lineTotal')}</th>
                {Number(po.lines.reduce((s, l) => s + Number(l.receivedQty), 0)) > 0 && <th className="end">{t('received')}</th>}
              </tr>
            </thead>
            <tbody>
              {po.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    <Link href={`/items/${l.itemId}`} style={{ color: 'inherit', fontWeight: 500 }}>
                      {pick({ name: l.itemName, nameAr: l.itemNameAr })}
                    </Link>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {ar && l.packNameAr ? l.packNameAr : l.packName}
                      {l.supplierSku && (
                        <>
                          {' · '}
                          <bdi className="nowrap">{l.supplierSku}</bdi>
                        </>
                      )}
                    </div>
                  </td>
                  <td className="end num">{Number(l.qty)}</td>
                  <td className="end num hide-phone">{fmtMoney(l.unitPrice)}</td>
                  <td className="end num">{fmtMoney(l.lineTotal)}</td>
                  {Number(po.lines.reduce((s, x) => s + Number(x.receivedQty), 0)) > 0 && (
                    <td className="end num">
                      <span className={`tag ${Number(l.receivedQty) >= Number(l.qty) ? 'tag-accent' : ''}`}>
                        {Number(l.receivedQty)} / {Number(l.qty)}
                      </span>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="totals">
          <span className="muted">{t('subtotal')}</span>
          <span className="num">{fmtMoney(po.subtotal)}</span>
          <span className="muted">
            {t('vat')} {Math.round(Number(po.taxRate) * 100)}%
          </span>
          <span className="num">{fmtMoney(po.taxTotal)}</span>
          <strong>{t('total')}</strong>
          <strong className="num">{fmtMoney(po.total)}</strong>
        </div>
        {po.notes && <div className="notice">{po.notes}</div>}

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {po.status === 'draft' && has('po:manage') && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act('submit')}>
              {t('submit')}
            </button>
          )}
          {po.status === 'pending_approval' && has('po:approve') && (
            <button className="btn btn-primary" disabled={busy} onClick={() => act('approve')}>
              {t('approve')}
            </button>
          )}
          {po.status === 'approved' && has('po:manage') && (po.supplier.orderChannel === 'whatsapp' && po.supplier.contactPhone ? (
            <>
              <button className="btn btn-primary" disabled={busy} onClick={() => act('send', { direct: true })}>
                {t('sendOnWhatsapp')}
              </button>
              <button className="btn btn-quiet" disabled={busy} onClick={() => act('send', { direct: false })}>
                {t('sendMyself')}
              </button>
            </>
          ) : (
            <button className="btn btn-primary" disabled={busy} onClick={() => act('send', { direct: false })}>
              {t('sendOrder')}
            </button>
          ))}
          {['approved', 'sent', 'partially_received'].includes(po.status) && has('stock:manage') && (
            <button className={`btn ${po.status === 'approved' ? 'btn-quiet' : 'btn-primary'}`} disabled={busy} onClick={() => setReceiving(true)}>
              {t('receive')}
            </button>
          )}
          {['pending_approval', 'approved'].includes(po.status) && has('po:manage') && (
            <button className="btn btn-quiet" disabled={busy} onClick={() => act('return')}>
              {t('backToDraft')}
            </button>
          )}
          {['partially_received', 'received'].includes(po.status) && has('po:manage') && (
            <button className="btn btn-quiet" disabled={busy} onClick={() => act('close')}>
              {t('closeOrder')}
            </button>
          )}
          <span style={{ flex: 1 }} />
          {['draft', 'pending_approval', 'approved', 'sent'].includes(po.status) && has('po:manage') && <ArmButton label={t('cancelOrder')} small={false} onConfirm={() => act('cancel')} />}
        </div>
      </section>

      {po.receipts.length > 0 && (
        <section className="card">
          <h2 className="card-title">{t('receipts')}</h2>
          {po.receipts.map((r) => (
            <div key={r.id} className="row-line">
              <span className="grow num" style={{ fontWeight: 500 }}>
                {r.number}
                {r.documentNo ? ` · ${r.documentNo}` : ''}
              </span>
              <span className="faint num">{fmtDate(r.receivedAt)}</span>
              <span className="num">{fmtMoney(r.total)}</span>
            </div>
          ))}
        </section>
      )}

      {invoices && invoices.length > 0 && (
        <section className="card">
          <h2 className="card-title">{t('invoicesForOrder')}</h2>
          {invoices.map((inv) => (
            <div key={inv.id} className="row-line">
              <Link href={`/invoices/${inv.id}`} className="grow num" style={{ fontWeight: 500 }}>
                <bdi>{inv.number ?? inv.ref}</bdi>
              </Link>
              <span className="num">{inv.total ? fmtMoney(inv.total) : '–'}</span>
              <InvoiceStatusTag status={inv.status} />
            </div>
          ))}
        </section>
      )}

      {(po.sentVia === 'whatsapp_direct' || po.supplierConfirmedAt || po.supplierIssue || po.conversation.length > 0) && (
        <section className="card">
          <h2 className="card-title">{t('supplierConversation')}</h2>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
            {po.supplierConfirmedAt ? (
              <span className="tag tag-accent">
                {t('supplierConfirmed')} · {po.supplierConfirmedVia === 'link' ? t('viaLink') : t('via_whatsapp')} · {fmtDate(po.supplierConfirmedAt)}
              </span>
            ) : (
              ['sent', 'partially_received'].includes(po.status) && <span className="tag">{t('awaitingSupplier')}</span>
            )}
          </div>
          {po.supplierIssue && (
            <div className="notice notice-error" style={{ marginBottom: 12 }}>
              <strong>{t('supplierIssue')}:</strong> {po.supplierIssue}
            </div>
          )}
          {po.conversation.length > 0 && (
            <div className="wa-thread wa-thread-static">
              {/* Newest last, shown from the bottom (column-reverse keeps it scrolled to the latest). */}
              {[...po.conversation].reverse().map((m) => (
                <div key={m.id} className={`wa-bubble-row ${m.dir === 'to_supplier' ? 'from-me' : 'from-boh'}`}>
                  <div className="wa-bubble">
                    <div className="wa-bubble-text" style={{ whiteSpace: 'pre-line' }}>
                      {m.text}
                    </div>
                    <div className="wa-bubble-time num">
                      {new Date(m.at).toLocaleString(ar ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      {m.status ? ` · ${t(`ms_${m.status}` as TKey)}` : ''}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {receiving && (
        <ReceiveDialog
          po={po}
          onClose={() => setReceiving(false)}
          onDone={(msg) => {
            setReceiving(false);
            setToast(msg);
            reload();
          }}
        />
      )}
      {sent && (
        <Dialog
          title={t('sendOrder')}
          onClose={() => setSent(null)}
          actions={
            <>
              {sent.links.whatsapp && (
                <a className="btn btn-quiet" href={sent.links.whatsapp} target="_blank" rel="noopener noreferrer">
                  {t('openWhatsapp')}
                </a>
              )}
              {sent.links.mailto && (
                <a className="btn btn-primary" href={sent.links.mailto} target="_blank" rel="noopener noreferrer">
                  {t('openEmail')}
                </a>
              )}
            </>
          }
        >
          <div className="notice">{t('orderSent')}</div>
          <pre className="message-draft" style={{ maxHeight: 280, overflow: 'auto' }}>
            {sent.message}
          </pre>
        </Dialog>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function ReceiveDialog({ po, onClose, onDone }: { po: PoDetail; onClose: () => void; onDone: (msg: string) => void }) {
  const { t, pick, lang } = useI18n();
  const { api } = useSession();
  const remaining = (l: PoDetail['lines'][number]) => Math.max(0, Number(l.qty) - Number(l.receivedQty));
  const [qty, setQty] = useState<Record<string, string>>(Object.fromEntries(po.lines.map((l) => [l.id, String(remaining(l))])));
  const [price, setPrice] = useState<Record<string, string>>(Object.fromEntries(po.lines.map((l) => [l.id, Number(l.unitPrice).toFixed(2)])));
  const [documentNo, setDocumentNo] = useState('');
  const [updatePrices, setUpdatePrices] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      title={t('receiveTitle')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const r = await api<{ receipt: { number: string }; priceChanges: unknown[] }>(`/purchase-orders/${po.id}/receive`, {
                  method: 'POST',
                  body: {
                    documentNo: documentNo || null,
                    updatePrices,
                    lines: po.lines.map((l) => ({ lineId: l.id, qty: Number(qty[l.id] || 0), unitPrice: Number(price[l.id]) })).filter((l) => l.qty > 0),
                  },
                });
                onDone(`${t('receiptPosted')} ${r.receipt.number}${r.priceChanges.length ? ` · ${t('pricesUpdated')}: ${r.priceChanges.length}` : ''}`);
              } catch (e) {
                setError((e as ApiError).message);
                setBusy(false);
              }
            }}
          >
            {t('postReceipt')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <Field label={t('documentNo')} hint={t('optional')}>
        <input className="input" value={documentNo} onChange={(e) => setDocumentNo(e.target.value)} dir="ltr" />
      </Field>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('name')}</th>
              <th className="end">{t('deliveredQty')}</th>
              <th className="end">{t('deliveredPrice')}</th>
            </tr>
          </thead>
          <tbody>
            {po.lines.map((l) => (
              <tr key={l.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{pick({ name: l.itemName, nameAr: l.itemNameAr })}</div>
                  <div className="faint num" style={{ fontSize: 12 }}>
                    {lang === 'ar' && l.packNameAr ? l.packNameAr : l.packName} · {remaining(l)} {t('remaining')}
                  </div>
                </td>
                <td className="end">
                  <input className="input inline-input num" style={{ width: 80, textAlign: 'end' }} inputMode="decimal" value={qty[l.id]} onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })} aria-label={`${t('deliveredQty')} ${l.itemName}`} />
                </td>
                <td className="end">
                  <input
                    className="input inline-input num"
                    style={{ width: 100, textAlign: 'end', borderColor: Number(price[l.id]) !== Number(l.unitPrice) ? 'var(--late)' : undefined }}
                    inputMode="decimal"
                    value={price[l.id]}
                    onChange={(e) => setPrice({ ...price, [l.id]: e.target.value })}
                    aria-label={`${t('deliveredPrice')} ${l.itemName}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label className="check">
        <input type="checkbox" checked={updatePrices} onChange={(e) => setUpdatePrices(e.target.checked)} />
        {t('updatePrices')}
      </label>
    </Dialog>
  );
}
