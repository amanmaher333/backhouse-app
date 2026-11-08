'use client';

import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { LangButton } from '@/components/toolbar';
import { useI18n } from '@/lib/i18n';

interface SupplierOrder {
  number: string;
  status: string;
  deliveryDate: string | null;
  notes: string | null;
  restaurant: { name: string; nameAr: string | null };
  site: { name: string; nameAr: string | null; address: Record<string, string> | null };
  supplier: { name: string; nameAr: string | null };
  lines: { itemName: string; itemNameAr: string | null; packName: string; packNameAr: string | null; supplierSku: string | null; qty: string; unitPrice: string | null; lineTotal: string | null }[];
  totals: { subtotal: string; tax: string; total: string } | null;
  confirmedAt: string | null;
  issue: string | null;
  canAnswer: boolean;
}

/** The supplier's view of an order sent through BOH. No account: the private link is the credential. */
export default function SupplierOrderPage() {
  const { token } = useParams<{ token: string }>();
  const { t, pick, lang, fmtMoney, fmtDate } = useI18n();
  const [order, setOrder] = useState<SupplierOrder | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'confirmed' | 'problem' | null>(null);
  const ar = lang === 'ar';

  const load = useCallback(async () => {
    const r = await fetch(`/api/v1/supplier-orders/${encodeURIComponent(token)}`, { cache: 'no-store' });
    if (!r.ok) return setInvalid(true);
    setOrder(await r.json());
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const post = async (path: string, body?: unknown) => {
    setBusy(true);
    try {
      const r = await fetch(`/api/v1/supplier-orders/${encodeURIComponent(token)}/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (r.ok) await load();
      return r.ok;
    } finally {
      setBusy(false);
    }
  };

  const qty = (q: string) => String(Number(q));
  const addr = order?.site.address ? Object.values(order.site.address).filter(Boolean).join(' · ') : '';

  return (
    <div className="supplier-page">
      <header className="supplier-head">
        <div className="supplier-brand">
          <span className="supplier-mark">B</span>
          <span className="faint" style={{ fontSize: 13 }}>
            {t('sentThroughBoh')}
          </span>
        </div>
        <LangButton />
      </header>

      {invalid ? (
        <div className="card">
          <div className="notice notice-error">{t('linkInvalid')}</div>
        </div>
      ) : !order ? (
        <div className="muted">{t('loading')}</div>
      ) : (
        <>
          <section className="card">
            <div className="faint" style={{ fontSize: 13 }}>
              {t('supplierOrder')}
            </div>
            <h1 className="supplier-title num">{order.number}</h1>
            <dl className="supplier-facts">
              <div>
                <dt>{t('orderFrom')}</dt>
                <dd>{pick(order.restaurant)}</dd>
              </div>
              <div>
                <dt>{t('deliverTo')}</dt>
                <dd>
                  {pick(order.site)}
                  {addr && <div className="faint" style={{ fontSize: 13 }}>{addr}</div>}
                </dd>
              </div>
              <div>
                <dt>{t('requestedDelivery')}</dt>
                <dd>{order.deliveryDate ? fmtDate(order.deliveryDate) : '–'}</dd>
              </div>
            </dl>
          </section>

          <section className="card">
            <h2 className="card-title">{t('lines')}</h2>
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('name')}</th>
                    <th className="end">{t('qty')}</th>
                    {order.totals && <th className="end hide-phone">{t('unitPrice')}</th>}
                    {order.totals && <th className="end">{t('lineTotal')}</th>}
                  </tr>
                </thead>
                <tbody>
                  {order.lines.map((l, i) => (
                    <tr key={i}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{ar ? (l.itemNameAr ?? l.itemName) : l.itemName}</div>
                        {l.supplierSku && (
                          <div className="faint num" style={{ fontSize: 12 }}>
                            <bdi>{l.supplierSku}</bdi>
                          </div>
                        )}
                      </td>
                      <td className="end num">
                        {qty(l.qty)} × {ar ? (l.packNameAr ?? l.packName) : l.packName}
                      </td>
                      {order.totals && <td className="end num hide-phone">{fmtMoney(l.unitPrice)}</td>}
                      {order.totals && <td className="end num">{fmtMoney(l.lineTotal)}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {order.totals && (
              <div className="totals">
                <span className="muted">{t('subtotal')}</span>
                <span className="num">{fmtMoney(order.totals.subtotal)}</span>
                <span className="muted">{t('vat')}</span>
                <span className="num">{fmtMoney(order.totals.tax)}</span>
                <strong>{t('total')}</strong>
                <strong className="num">{fmtMoney(order.totals.total)}</strong>
              </div>
            )}
            {order.notes && <div className="notice">{order.notes}</div>}
          </section>

          <section className="card">
            <h2 className="card-title">{t('yourAnswer')}</h2>
            {order.confirmedAt && <div className="notice notice-info">{done === 'confirmed' ? t('confirmedThanks') : `${t('supplierConfirmed')} · ${fmtDate(order.confirmedAt)}`}</div>}
            {order.issue && (
              <div className="notice" style={{ marginTop: 8 }}>
                {done === 'problem' ? t('problemThanks') : `${t('supplierIssue')}: ${order.issue}`}
              </div>
            )}
            {!order.canAnswer ? (
              <div className="notice">{t('orderClosed')}</div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 12 }}>
                {problem === null ? (
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                    {!order.confirmedAt && (
                      <button className="btn btn-primary" disabled={busy} onClick={async () => (await post('confirm')) && setDone('confirmed')}>
                        {t('confirmOrder')}
                      </button>
                    )}
                    <button className="btn btn-quiet" disabled={busy} onClick={() => setProblem('')}>
                      {t('reportProblem')}
                    </button>
                  </div>
                ) : (
                  <>
                    <textarea
                      className="input"
                      style={{ minHeight: 90, padding: 12 }}
                      placeholder={t('problemPlaceholder')}
                      aria-label={t('reportProblem')}
                      value={problem}
                      onChange={(e) => setProblem(e.target.value)}
                      autoFocus
                    />
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        className="btn btn-primary"
                        disabled={busy || !problem.trim()}
                        onClick={async () => {
                          if (await post('problem', { message: problem })) {
                            setProblem(null);
                            setDone('problem');
                          }
                        }}
                      >
                        {t('sendProblem')}
                      </button>
                      <button className="btn btn-quiet" onClick={() => setProblem(null)}>
                        {t('cancel')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}
