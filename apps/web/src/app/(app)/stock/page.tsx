'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Dialog, Empty, Field, PageHead, Toast } from '@/components/ui';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { ItemDetail, Site } from '@/lib/types';
import type { StockRow } from '@/lib/types-procurement';
import type { CountRow } from '@/lib/types-counts';

export default function StockPage() {
  const { t, pick, fmtQty, fmtMoney } = useI18n();
  const { can, me } = useSession();
  const { data: sites } = useApi<Site[]>('/sites');
  const [siteId, setSiteId] = useState('');
  const [lowOnly, setLowOnly] = useState(false);
  const [counting, setCounting] = useState<StockRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(() => {
    if (!siteId && sites?.[0]) setSiteId(sites[0].id);
  }, [sites, siteId]);
  const { data: rows, reload } = useApi<StockRow[]>(siteId ? `/sites/${siteId}/stock` : null, [siteId]);
  const { data: activeCounts } = useApi<CountRow[]>(siteId ? `/stock-counts?status=active&siteId=${siteId}` : null, [siteId]);
  const inProgress = activeCounts?.[0];
  const canCount = !!me?.memberships.some(
    (m) => m.permissions.some((p) => p === '*' || p === 'stock:manage' || p === 'stock:*') && (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(siteId)),
  );
  const shown = rows?.filter((r) => !lowOnly || r.status === 'low') ?? [];
  const lowCount = rows?.filter((r) => r.status === 'low').length ?? 0;
  const totalValue = rows?.reduce((s, r) => s + Number(r.value ?? 0), 0) ?? 0;

  return (
    <div className="page">
      <PageHead
        title={t('stock')}
        sub={t('stockSub')}
        action={
          <Link className="btn btn-quiet" href="/stock/counts">
            {t('counts')}
          </Link>
        }
      />
      {inProgress && (
        <div className="notice notice-info" style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
          <span>
            {t('openCountBanner')} · <bdi className="num">{inProgress.ref}</bdi> ({inProgress.counted}/{inProgress.lines})
          </span>
          <Link className="btn btn-sm btn-primary" href={`/stock/counts/${inProgress.id}`}>
            {t('continueCounting')}
          </Link>
        </div>
      )}
      <div className="filters">
        <select className="select" style={{ flex: '0 1 260px' }} value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label={t('site')}>
          {sites?.map((s) => (
            <option key={s.id} value={s.id}>
              {pick(s)}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={lowOnly} onChange={(e) => setLowOnly(e.target.checked)} />
          {t('low')} ({lowCount})
        </label>
      </div>

      {rows && (
        <div className="stats">
          <div className="stat">
            <div className="stat-label">{t('items')}</div>
            <div className="stat-value">{rows.length}</div>
          </div>
          <div className="stat">
            <div className="stat-label">{t('low')}</div>
            <div className="stat-value">{lowCount}</div>
          </div>
          {can('price:read') && (
            <div className="stat">
              <div className="stat-label">{t('value')}</div>
              <div className="stat-value" style={{ fontSize: 22 }}>
                {fmtMoney(totalValue)}
              </div>
            </div>
          )}
        </div>
      )}

      {rows && rows.length === 0 ? (
        <div className="card">
          <Empty title={t('noItems')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th className="end">{t('onHand')}</th>
                <th className="end hide-phone">{t('reorderPoint')}</th>
                <th className="end hide-phone">{t('par')}</th>
                {can('price:read') && <th className="end hide-phone">{t('value')}</th>}
                <th>{t('status')}</th>
                {canCount && <th className="end" />}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.itemId}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{pick(r)}</div>
                    <div className="faint num" style={{ fontSize: 12 }}>
                      {r.code}
                    </div>
                  </td>
                  <td className="end num">{r.lastMovementAt ? fmtQty(r.qtyOnHand, r.baseUnit) : <span className="faint">{t('notCounted')}</span>}</td>
                  <td className="end num hide-phone">{r.reorderPoint ?? r.parLevel ? fmtQty((r.reorderPoint ?? r.parLevel)!, r.baseUnit) : '–'}</td>
                  <td className="end num hide-phone">{r.parLevel ? fmtQty(r.parLevel, r.baseUnit) : '–'}</td>
                  {can('price:read') && <td className="end num hide-phone">{r.value ? fmtMoney(r.value) : '–'}</td>}
                  <td>
                    <span className={`tag ${r.status === 'low' ? 'tag-late' : r.status === 'ok' ? 'tag-accent' : ''}`}>{t((r.status === 'no_par' ? 'noPar' : r.status) as TKey)}</span>
                  </td>
                  {canCount && (
                    <td className="end">
                      <button className="btn btn-sm btn-quiet" onClick={() => setCounting(r)}>
                        {t('setCount')}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {counting && (
        <CountDialog
          siteId={siteId}
          row={counting}
          onClose={() => setCounting(null)}
          onDone={() => {
            setCounting(null);
            setToast(t('saved'));
            reload();
          }}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function CountDialog({ siteId, row, onClose, onDone }: { siteId: string; row: StockRow; onClose: () => void; onDone: () => void }) {
  const { t, pick, lang } = useI18n();
  const { api } = useSession();
  const { data: item } = useApi<ItemDetail>(`/items/${row.itemId}`, [row.itemId]);
  const [qty, setQty] = useState('');
  const [packId, setPackId] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (item && !packId) setPackId(item.packs.find((p) => p.isCountable)?.id ?? item.packs[0]?.id ?? '');
  }, [item, packId]);

  return (
    <Dialog
      title={`${t('countTitle')} · ${pick(row)}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={qty === '' || !Number.isFinite(Number(qty))}
            onClick={async () => {
              try {
                await api(`/sites/${siteId}/stock/set`, { method: 'POST', body: { itemId: row.itemId, qty: Number(qty), ...(packId ? { packId } : {}) } });
                onDone();
              } catch (e) {
                setError((e as ApiError).message);
              }
            }}
          >
            {t('save')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <div className="form-row">
        <Field label={t('counted')}>
          <input className="input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} autoFocus />
        </Field>
        <Field label={t('in')}>
          <select className="select" value={packId} onChange={(e) => setPackId(e.target.value)}>
            {item?.packs.map((p) => (
              <option key={p.id} value={p.id}>
                {lang === 'ar' && p.nameAr ? p.nameAr : p.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}
