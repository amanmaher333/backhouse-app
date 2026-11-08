'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Empty, PageHead } from '@/components/ui';
import { IconBot, IconPlus } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { PoStatusTag } from '@/components/procurement';
import { useApi, useSession } from '@/lib/session';
import type { Site } from '@/lib/types';
import type { PoRow } from '@/lib/types-procurement';

export default function OrdersPage() {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const { can } = useSession();
  const [status, setStatus] = useState<'open' | 'all'>('open');
  const [siteId, setSiteId] = useState('');
  const { data: sites } = useApi<Site[]>('/sites');
  const { data: orders } = useApi<PoRow[]>(`/purchase-orders?status=${status}${siteId ? `&siteId=${siteId}` : ''}`, [status, siteId]);

  return (
    <div className="page">
      <PageHead
        title={t('orders')}
        sub={t('ordersSub')}
        action={
          can('po:manage') && (
            <Link className="btn btn-primary" href="/orders/new">
              <IconPlus /> {t('newOrder')}
            </Link>
          )
        }
      />
      <div className="filters">
        <div className="segmented" role="group">
          <button aria-pressed={status === 'open'} onClick={() => setStatus('open')}>
            {t('openOrders')}
          </button>
          <button aria-pressed={status === 'all'} onClick={() => setStatus('all')}>
            {t('allOrders')}
          </button>
        </div>
        {sites && sites.length > 1 && (
          <select className="select" style={{ flex: '0 1 240px' }} value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label={t('site')}>
            <option value="">{t('allSites')}</option>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {pick(s)}
              </option>
            ))}
          </select>
        )}
      </div>

      {orders && orders.length === 0 ? (
        <div className="card">
          <Empty title={t('noOrders')} body={t('noOrdersBody')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('poNumber')}</th>
                <th>{t('supplier')}</th>
                <th className="hide-phone">{t('site')}</th>
                <th className="hide-phone">{t('delivery')}</th>
                <th className="end">{t('total')}</th>
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {orders?.map((o) => (
                <tr key={o.id}>
                  <td>
                    <Link href={`/orders/${o.id}`} style={{ fontWeight: 600, display: 'inline-flex', gap: 6, alignItems: 'center' }} className="num">
                      {o.number}
                      {o.source === 'agent' && <IconBot width={16} height={16} aria-label={t('byAgent')} />}
                    </Link>
                  </td>
                  <td>{pick({ name: o.supplierName, nameAr: o.supplierNameAr })}</td>
                  <td className="hide-phone muted">{pick({ name: o.siteName, nameAr: o.siteNameAr })}</td>
                  <td className="hide-phone num">{o.deliveryDate ? fmtDate(o.deliveryDate) : '–'}</td>
                  <td className="end num">{fmtMoney(o.total)}</td>
                  <td>
                    <PoStatusTag status={o.status} />
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
