'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArmButton, PageHead, Toast } from '@/components/ui';
import { StockTabs, TransferStatusTag, readNumber, useEntryLabel } from '@/components/stock';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { TransferDetail, TransferLine } from '@/lib/types-stock';

export default function TransferPage() {
  const { id } = useParams<{ id: string }>();
  const { t, pick, fmtMoney, fmtQty, fmtDate, lang } = useI18n();
  const { api, can } = useSession();
  const { data: tr, setData, error: loadError } = useApi<TransferDetail>(`/stock-transfers/${id}`, [id]);
  const [receiving, setReceiving] = useState(false);
  /** Received quantities that differ from what was sent, in the line's own unit or pack, by line id. */
  const [got, setGot] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const entryLabel = useEntryLabel();

  const act = async (path: string, body: unknown = {}, message?: string) => {
    setError(null);
    try {
      setData(await api<TransferDetail>(`/stock-transfers/${id}/${path}`, { method: 'POST', body }));
      setReceiving(false);
      if (message) setToast(message);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  if (loadError) return <div className="page"><div className="notice notice-error">{loadError.message}</div></div>;
  if (!tr) return <div className="page" />;
  const showCost = can('price:read');
  const changed = Object.entries(got).filter(([, v]) => v.trim() !== '');
  const receiveBody = {
    lines: changed.map(([lineId, v]) => {
      const l = tr.lines.find((x) => x.id === lineId)!;
      return { lineId, qty: readNumber(v), ...(l.entryPackId ? { packId: l.entryPackId } : { unit: l.entryUnit ?? l.baseUnit }) };
    }),
  };

  return (
    <div className="page">
      <PageHead
        title={tr.ref}
        sub={`${pick({ name: tr.fromName, nameAr: tr.fromNameAr })} ${lang === 'ar' ? '←' : '→'} ${pick({ name: tr.toName, nameAr: tr.toNameAr })}`}
        action={<TransferStatusTag status={tr.status} />}
      />
      <StockTabs />
      {error && <div className="notice notice-error">{error}</div>}

      <section className="card" style={{ gap: 6 }}>
        <dl className="dl">
          {tr.sentAt && (
            <>
              <dt>{t('transfer_sent')}</dt>
              <dd className="num">{fmtDate(tr.sentAt)}</dd>
            </>
          )}
          {tr.receivedAt && (
            <>
              <dt>{t('transfer_received')}</dt>
              <dd className="num">{fmtDate(tr.receivedAt)}</dd>
            </>
          )}
          {showCost && tr.value && (
            <>
              <dt>{t('transferValue')}</dt>
              <dd className="num">{fmtMoney(tr.value)}</dd>
            </>
          )}
          {showCost && Number(tr.shortValue ?? 0) !== 0 && (
            <>
              <dt>{t('shortage')}</dt>
              <dd className="num cell-flag">{fmtMoney(tr.shortValue!)}</dd>
            </>
          )}
          {tr.note && (
            <>
              <dt>{t('note')}</dt>
              <dd style={{ whiteSpace: 'pre-line' }}>{tr.note}</dd>
            </>
          )}
        </dl>
      </section>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('item')}</th>
              <th className="end">{t('sentQty')}</th>
              {(tr.status === 'received' || receiving) && <th className="end">{t('receivedQty')}</th>}
              {showCost && <th className="end hide-phone">{t('value')}</th>}
            </tr>
          </thead>
          <tbody>
            {tr.lines.map((l) => (
              <tr key={l.id}>
                <td style={{ fontWeight: 500 }}>{pick(l)}</td>
                <td className="end num">
                  {entryLabel(l.entryQty, l.entryUnit, l.entryPackId, l.packs, l.baseUnit)}
                  {l.entryPackId && (
                    <div className="faint" style={{ fontSize: 12 }}>
                      {fmtQty(l.qtyBase, l.baseUnit)}
                    </div>
                  )}
                </td>
                {receiving && (
                  <td className="end">
                    <ReceiveInput line={l} value={got[l.id] ?? ''} onChange={(v) => setGot({ ...got, [l.id]: v })} />
                  </td>
                )}
                {tr.status === 'received' && (
                  <td className="end num">
                    {fmtQty(l.receivedQty ?? 0, l.baseUnit)}
                    {Number(l.receivedQty) !== Number(l.qtyBase) && (
                      <div className="cell-flag" style={{ fontSize: 12 }}>
                        {t('shortage')} {fmtQty(Number(l.qtyBase) - Number(l.receivedQty ?? 0), l.baseUnit)}
                      </div>
                    )}
                  </td>
                )}
                {showCost && <td className="end num hide-phone">{l.unitCost ? fmtMoney(Number(l.unitCost) * Number(l.qtyBase)) : '–'}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {(tr.status === 'draft' || tr.status === 'sent') && (
        <div className="count-bar">
          <span className="faint" style={{ fontSize: 13, flex: '1 1 220px' }}>
            {tr.status === 'draft' ? t('sendTransferHint') : receiving ? t('receiveHint') : ''}
          </span>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {tr.canSend && <ArmButton label={t('cancelTransfer')} small={false} onConfirm={() => act('cancel')} />}
            {tr.status === 'draft' && tr.canSend && (
              <button className="btn btn-primary" onClick={() => act('send', {}, t('transferSent'))}>
                {t('sendTransfer')}
              </button>
            )}
            {tr.status === 'sent' && tr.canReceive && !receiving && (
              <button className="btn btn-primary" onClick={() => setReceiving(true)}>
                {t('receiveTransfer')}
              </button>
            )}
            {receiving && (
              <>
                <button className="btn btn-quiet" onClick={() => setReceiving(false)}>
                  {t('cancel')}
                </button>
                <button className="btn btn-primary" onClick={() => act('receive', receiveBody, t('transferReceived'))}>
                  {t('confirmReceipt')}
                </button>
              </>
            )}
          </div>
        </div>
      )}
      <div>
        <Link href="/stock/transfers" className="link-btn">
          ← {t('transfers')}
        </Link>
      </div>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/** What arrived, in the unit or pack it was sent in; empty means all of it. */
function ReceiveInput({ line, value, onChange }: { line: TransferLine; value: string; onChange: (v: string) => void }) {
  const { t, pick } = useI18n();
  const pack = line.packs.find((p) => p.id === line.entryPackId);
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input
        className="input num"
        style={{ width: 90, textAlign: 'end' }}
        inputMode="decimal"
        placeholder={String(Number(line.entryQty))}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={`${t('receivedQty')} · ${pick(line)}`}
      />
      <span className="faint" style={{ fontSize: 12 }}>
        {pack ? pick(pack) : line.entryUnit}
      </span>
    </span>
  );
}
