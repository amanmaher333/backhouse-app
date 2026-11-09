'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Empty, PageHead } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { StockTabs, TransferStatusTag } from '@/components/stock';
import { useI18n } from '@/lib/i18n';
import { useApi, useSession } from '@/lib/session';
import type { TransferRow } from '@/lib/types-stock';

export default function TransfersPage() {
  const { t, pick, fmtMoney, fmtDate, lang } = useI18n();
  const arrow = lang === 'ar' ? '←' : '→';
  const { can } = useSession();
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const { data: rows } = useApi<TransferRow[]>(`/stock-transfers?status=${status}`, [status]);

  return (
    <div className="page">
      <PageHead
        title={t('transfers')}
        sub={t('transfersSub')}
        action={
          can('stock:manage') && (
            <Link className="btn btn-primary" href="/stock/transfers/new">
              <IconPlus /> {t('newTransfer')}
            </Link>
          )
        }
      />
      <StockTabs />
      <div className="filters">
        <div className="segmented" role="group">
          {(['active', 'all'] as const).map((s) => (
            <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {t(s === 'active' ? 'transfersActive' : 'countsAll')}
            </button>
          ))}
        </div>
      </div>
      {rows && rows.length === 0 ? (
        <div className="card">
          <Empty title={t('noTransfers')} body={t('noTransfersBody')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('transfers')}</th>
                <th>
                  {t('fromSite')} {arrow} {t('toSite')}
                </th>
                <th className="end hide-phone">{t('lines')}</th>
                {can('price:read') && <th className="end hide-phone">{t('transferValue')}</th>}
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/stock/transfers/${r.id}`} className="num" style={{ fontWeight: 600 }}>
                      <bdi>{r.ref}</bdi>
                    </Link>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {fmtDate(r.sentAt ?? r.createdAt)}
                    </div>
                  </td>
                  <td>
                    {pick({ name: r.fromName, nameAr: r.fromNameAr })} <span className="faint">{arrow}</span> {pick({ name: r.toName, nameAr: r.toNameAr })}
                  </td>
                  <td className="end num hide-phone">{r.lines}</td>
                  {can('price:read') && (
                    <td className="end num hide-phone">
                      {r.value ? fmtMoney(r.value) : '–'}
                      {Number(r.shortValue ?? 0) > 0 && (
                        <div className="cell-flag" style={{ fontSize: 12 }}>
                          {t('shortage')} {fmtMoney(r.shortValue!)}
                        </div>
                      )}
                    </td>
                  )}
                  <td>
                    <TransferStatusTag status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
