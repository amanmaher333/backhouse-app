'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Empty, PageHead } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { SaleStatusTag } from '@/components/sales';
import { useI18n, type TKey } from '@/lib/i18n';
import { useApi, useSession } from '@/lib/session';
import type { SaleRow } from '@/lib/types-sales';

type Tab = 'all' | 'pending' | 'cleared' | 'reported';

export default function SalesPage() {
  const { t, fmtMoney, fmtDate } = useI18n();
  const { can } = useSession();
  const [tab, setTab] = useState<Tab>('all');
  const { data: rows } = useApi<SaleRow[]>(`/sales-invoices?status=${tab}`, [tab]);
  const tabs: { key: Tab; label: TKey }[] = [
    { key: 'all', label: 'tabAll' },
    { key: 'pending', label: 'tabReview' },
    { key: 'cleared', label: 'sale_cleared' },
    { key: 'reported', label: 'sale_reported' },
  ];

  return (
    <div className="page">
      <PageHead
        title={t('salesInvoices')}
        sub={t('salesInvoicesSub')}
        action={
          can('sales_invoice:manage') && (
            <Link className="btn btn-primary" href="/sales/new">
              <IconPlus /> {t('newSalesInvoice')}
            </Link>
          )
        }
      />
      <div className="filters">
        <div className="segmented" role="group">
          {tabs.map((x) => (
            <button key={x.key} aria-pressed={tab === x.key} onClick={() => setTab(x.key)}>
              {t(x.label)}
            </button>
          ))}
        </div>
      </div>
      {rows && rows.length === 0 ? (
        <div className="card">
          <Empty title={t('noSales')} body={t('noSalesBody')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('invoice')}</th>
                <th>{t('buyer')}</th>
                <th className="hide-phone">{t('issueDate')}</th>
                <th className="end">{t('total')}</th>
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/sales/${r.id}`} className="num" style={{ fontWeight: 600 }}>
                      {r.number}
                    </Link>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {t(`kind_${r.kind}` as TKey)}
                      {r.type !== 'invoice' ? ` · ${t(`docType_${r.type}` as TKey)}` : ''}
                    </div>
                  </td>
                  <td>{r.buyer?.name ?? <span className="faint">–</span>}</td>
                  <td className="hide-phone num">{r.issueDate ? fmtDate(r.issueDate) : '–'}</td>
                  <td className="end num">{fmtMoney(r.total)}</td>
                  <td>
                    <SaleStatusTag status={r.status} />
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
