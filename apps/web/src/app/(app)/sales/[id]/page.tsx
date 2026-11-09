'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useState } from 'react';
import { PageHead, Toast } from '@/components/ui';
import { SaleStatusTag, ZatcaQr } from '@/components/sales';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { SaleDetail } from '@/lib/types-sales';

/** Bilingual document titles as printed on ZATCA invoices. */
const TITLE: Record<string, [string, string]> = {
  'standard:invoice': ['فاتورة ضريبية', 'Tax invoice'],
  'simplified:invoice': ['فاتورة ضريبية مبسطة', 'Simplified tax invoice'],
  'standard:credit_note': ['إشعار دائن', 'Credit note'],
  'simplified:credit_note': ['إشعار دائن مبسط', 'Simplified credit note'],
  'standard:debit_note': ['إشعار مدين', 'Debit note'],
  'simplified:debit_note': ['إشعار مدين مبسط', 'Simplified debit note'],
};

export default function SalePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { t, fmtMoney, fmtDate } = useI18n();
  const { api, can } = useSession();
  const { data: inv, error, reload } = useApi<SaleDetail>(`/sales-invoices/${id}`, [id]);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  if (error) return <div className="notice notice-error">{error.message}</div>;
  if (!inv) return <div className="muted">{t('loading')}</div>;
  const manage = can('sales_invoice:manage');
  const [titleAr, titleEn] = TITLE[`${inv.kind}:${inv.type}`]!;
  const done = ['cleared', 'reported'].includes(inv.status);
  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      reload();
    } catch (e) {
      setToast((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const download = async () => {
    const blob = await api<Blob>(`/sales-invoices/${id}/xml`, { blob: true });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${inv.number}.xml`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 30_000);
  };
  const addr = (a?: { street?: string; building?: string; district?: string; city?: string; postalCode?: string } | null) => (a ? [a.building && a.street ? `${a.building} ${a.street}` : a.street, a.district, a.city, a.postalCode].filter(Boolean).join('، ') : '');
  const v = inv.validation;

  return (
    <div className="page">
      <PageHead
        title={`${t(`docType_${inv.type}` as TKey)} ${inv.number}`}
        sub={[t(`kind_${inv.kind}` as TKey), inv.issueDate ? fmtDate(inv.issueDate) : null, inv.unit ? `${inv.unit.name} · ${t(`env_${inv.unit.environment}` as TKey)}` : null].filter(Boolean).join(' · ')}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <SaleStatusTag status={inv.status} />
          </div>
        }
      />

      {inv.status === 'issued' && <div className={`notice ${inv.reportingOverdue ? 'notice-error' : ''}`}>{inv.reportingOverdue ? t('overdueNote') : t('waitingNote')}{inv.lastError ? ` (${inv.lastError})` : ''}</div>}
      {inv.status === 'rejected' && (
        <div className="notice notice-error">
          <strong>{t('rejectedNote')}</strong>
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {(v?.errorMessages ?? []).map((m, i) => (
              <li key={i}>
                <bdi>{m.code}</bdi>: {m.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {inv.kind === 'standard' && inv.type === 'invoice' && !done && inv.status !== 'rejected' && <div className="notice">{t('notSharedYet')}</div>}
      {done && (v?.warningMessages?.length ?? 0) > 0 && (
        <div className="notice">
          <strong>{t('zatcaWarnings')}:</strong>
          <ul style={{ margin: '6px 0 0', paddingInlineStart: 18 }}>
            {v!.warningMessages!.map((m, i) => (
              <li key={i}>
                <bdi>{m.code}</bdi>: {m.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="card invoice-card">
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>{titleAr}</div>
          <div className="muted">{titleEn}</div>
        </div>
        <div className="invoice-parties">
          <div>
            <div className="faint" style={{ fontSize: 12 }}>
              {t('seller')}
            </div>
            <div style={{ fontWeight: 600 }}>{inv.seller?.name}</div>
            {inv.seller?.vatNumber && (
              <div className="num" style={{ fontSize: 13 }}>
                {t('sellerVat')}: <bdi>{inv.seller.vatNumber}</bdi>
              </div>
            )}
            {inv.seller?.id && (
              <div className="num" style={{ fontSize: 13 }}>
                {t('crNumber')}: <bdi>{inv.seller.id.value}</bdi>
              </div>
            )}
            <div className="faint" style={{ fontSize: 13 }}>
              {addr(inv.seller?.address)}
            </div>
          </div>
          <div>
            <div className="faint" style={{ fontSize: 12 }}>
              {t('buyer')}
            </div>
            {inv.buyer ? (
              <>
                <div style={{ fontWeight: 600 }}>{inv.buyer.name}</div>
                {inv.buyer.vatNumber && (
                  <div className="num" style={{ fontSize: 13 }}>
                    {t('sellerVat')}: <bdi>{inv.buyer.vatNumber}</bdi>
                  </div>
                )}
                <div className="faint" style={{ fontSize: 13 }}>
                  {addr(inv.buyer.address)}
                </div>
              </>
            ) : (
              <div className="faint">–</div>
            )}
          </div>
          {inv.qr && done ? <ZatcaQr value={inv.qr} /> : <div />}
        </div>
        <dl className="dl" style={{ fontSize: 13 }}>
          <dt>{t('invoiceNo')}</dt>
          <dd className="num">{inv.number}</dd>
          {inv.issueDate && (
            <>
              <dt>{t('issueDate')}</dt>
              <dd className="num">
                <bdi>
                  {inv.issueDate} {inv.issueTime}
                </bdi>
              </dd>
            </>
          )}
          {inv.supplyDate && (
            <>
              <dt>{t('supplyDate')}</dt>
              <dd className="num">{fmtDate(inv.supplyDate)}</dd>
            </>
          )}
          {inv.billingReference && (
            <>
              <dt>{t('originalInvoice')}</dt>
              <dd className="num">
                {inv.originalInvoiceId ? <Link href={`/sales/${inv.originalInvoiceId}`}>{inv.billingReference}</Link> : inv.billingReference}
              </dd>
            </>
          )}
          {inv.reason && (
            <>
              <dt>{t('reasonForNote')}</dt>
              <dd>{inv.reason}</dd>
            </>
          )}
          <dt>{t('paymentMeans')}</dt>
          <dd>{t(`pm_${inv.paymentMeansCode}` as TKey)}</dd>
        </dl>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('item')}</th>
                <th className="end">{t('qty')}</th>
                <th className="end hide-phone">{t('unitPriceEx')}</th>
                <th className="end hide-phone">{t('vatCategory')}</th>
                <th className="end">{t('netAmount')}</th>
                <th className="end">{t('vatAmount')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.id}>
                  <td>
                    {l.name}
                    {Number(l.discount) > 0 && (
                      <div className="faint num" style={{ fontSize: 12 }}>
                        {t('discount')} {fmtMoney(l.discount)}
                      </div>
                    )}
                  </td>
                  <td className="end num">{Number(l.qty)}</td>
                  <td className="end num hide-phone">{fmtMoney(l.unitPrice)}</td>
                  <td className="end hide-phone">{l.vatCategory === 'S' ? `${Number(l.vatRate)}%` : t(`vat_${l.vatCategory}` as TKey)}</td>
                  <td className="end num">{fmtMoney(l.net)}</td>
                  <td className="end num">{fmtMoney(l.vat)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="totals">
          <span className="muted">{t('subtotal')}</span>
          <span className="num">{fmtMoney(inv.subtotal)}</span>
          <span className="muted">{t('vat')}</span>
          <span className="num">{fmtMoney(inv.taxTotal)}</span>
          <strong>{t('totalWithVat')}</strong>
          <strong className="num">{fmtMoney(inv.total)}</strong>
        </div>
        {inv.note && <div className="faint" style={{ fontSize: 13 }}>{inv.note}</div>}
        {inv.icv !== null && (
          <div className="faint num" style={{ fontSize: 11, overflowWrap: 'anywhere' }}>
            {t('icv')} {inv.icv} · {t('invoiceHash')} <bdi>{inv.hash}</bdi>
          </div>
        )}
      </section>

      <div className="no-print" style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {inv.status === 'draft' && manage && (
          <>
            <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`/sales-invoices/${id}/issue`, { method: 'POST' }))}>
              {t('issueNow')}
            </button>
            <button className="btn btn-quiet" disabled={busy} onClick={() => act(async () => { await api(`/sales-invoices/${id}`, { method: 'DELETE' }); router.push('/sales'); })}>
              {t('remove')}
            </button>
          </>
        )}
        {inv.status === 'issued' && manage && (
          <button className="btn btn-primary" disabled={busy} onClick={() => act(() => api(`/sales-invoices/${id}/submit`, { method: 'POST' }))}>
            {t('retryNow')}
          </button>
        )}
        {done && (
          <button className="btn btn-quiet" onClick={() => window.print()}>
            {t('print')}
          </button>
        )}
        {inv.hasXml && (
          <button className="btn btn-quiet" onClick={() => download().catch((e) => setToast((e as Error).message))}>
            {t('downloadXml')}
          </button>
        )}
        {done && inv.type === 'invoice' && manage && (
          <>
            <Link className="btn btn-quiet" href={`/sales/new?type=credit_note&original=${inv.id}`}>
              {t('createCreditNote')}
            </Link>
            <Link className="btn btn-quiet" href={`/sales/new?type=debit_note&original=${inv.id}`}>
              {t('createDebitNote')}
            </Link>
          </>
        )}
      </div>

      {inv.notes.length > 0 && (
        <section className="card no-print">
          <h2 className="card-title">{t('creditNotes')}</h2>
          {inv.notes.map((n) => (
            <div key={n.id} className="row-line">
              <Link href={`/sales/${n.id}`} className="grow num" style={{ fontWeight: 500 }}>
                {n.number} · {t(`docType_${n.type}` as TKey)}
              </Link>
              <span className="num">{fmtMoney(n.total)}</span>
              <SaleStatusTag status={n.status} />
            </div>
          ))}
        </section>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}
