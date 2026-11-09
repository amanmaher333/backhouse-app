'use client';

import { useMemo, useState } from 'react';
import { ArmButton, Empty, PageHead, Toast } from '@/components/ui';
import { readNumber } from '@/components/stock';
import { unitLabel } from '@/components/counts';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Site } from '@/lib/types';
import type { StockItem } from '@/lib/types-stock';
import type { FoodicsStatus, PosItem, PosLocation, PosProduct, PosPush, PosSales } from '@/lib/types-pos';

type Tab = 'branches' | 'items' | 'menu' | 'sales' | 'purchases';

export default function IntegrationsPage() {
  const { t, fmtDate } = useI18n();
  const { api, can } = useSession();
  const { data: status, reload, setData } = useApi<FoodicsStatus>('/integrations/foodics');
  const [busy, setBusy] = useState<'connect' | 'sync' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('branches');
  const [version, setVersion] = useState(0);
  const manage = can('pos:manage');

  const connect = async () => {
    setBusy('connect');
    setError(null);
    try {
      const { url } = await api<{ url: string }>('/integrations/foodics/connect', { method: 'POST' });
      window.location.href = url;
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(null);
    }
  };
  const sync = async () => {
    setBusy('sync');
    setError(null);
    try {
      await api('/integrations/foodics/sync', { method: 'POST' });
      setToast(t('synced'));
      reload();
      setVersion((v) => v + 1);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <PageHead title={t('integrations')} sub={t('integrationsSub')} />
      {error && <div className="notice notice-error">{error}</div>}

      <section className="card" style={{ gap: 12 }}>
        <div className="integration-head">
          <div className="integration-mark" aria-hidden>
            F
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="card-title">Foodics</div>
            {status?.connected ? (
              <div className="muted" style={{ fontSize: 14 }}>
                {t('connectedTo')} <strong>{status.connection.businessName}</strong> <span className="faint num">#{status.connection.businessReference}</span>
              </div>
            ) : (
              <div className="muted" style={{ fontSize: 14 }}>
                {t('foodicsBlurb')}
              </div>
            )}
          </div>
          {status?.connected ? (
            <span className={`tag ${status.connection.status === 'connected' ? 'tag-accent' : 'tag-late'}`}>
              <span className="dot" />
              {status.connection.status === 'connected' ? t('linked') : t('callbackFailed')}
            </span>
          ) : null}
        </div>

        {status?.mode === 'simulated' && <div className="notice notice-info">{t('foodicsDemoMode')}</div>}
        {status?.connected && status.connection.status === 'error' && <div className="notice notice-error">{t('connectionError')}</div>}
        {status?.connected && status.connection.lastError && status.connection.status === 'connected' && <div className="notice">{status.connection.lastError}</div>}

        {status && !status.connected && manage && (
          <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={connect} disabled={busy !== null}>
              {busy === 'connect' ? t('connecting') : t('connectFoodics')}
            </button>
            <span className="faint" style={{ fontSize: 13 }}>
              {t('ownerOnly')}
            </span>
          </div>
        )}

        {status?.connected && (
          <>
            <div className="stats" style={{ marginTop: 4 }}>
              <div className="stat">
                <div className="stat-label">{t('tabBranches')}</div>
                <div className="stat-value num">
                  {status.locations.mapped}/{status.locations.total}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('tabItems')}</div>
                <div className="stat-value num">
                  {status.items.mapped}/{status.items.total}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('ordersImported')}</div>
                <div className="stat-value num">{status.orders.imported}</div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <span className="faint" style={{ fontSize: 13, flex: '1 1 200px' }}>
                {t('lastSynced')}: {status.connection.ordersSyncedAt ? `${fmtDate(status.connection.ordersSyncedAt)} ${new Date(status.connection.ordersSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '–'}
              </span>
              {manage && (
                <>
                  <button className="btn btn-quiet" onClick={sync} disabled={busy !== null}>
                    {busy === 'sync' ? t('syncing') : t('syncNow')}
                  </button>
                  <ArmButton
                    label={t('disconnect')}
                    small={false}
                    onConfirm={async () => {
                      try {
                        await api('/integrations/foodics/disconnect', { method: 'POST' });
                        setToast(t('disconnected'));
                        reload();
                      } catch (e) {
                        setError((e as ApiError).message);
                      }
                    }}
                  />
                </>
              )}
            </div>
            {manage && (
              <label className="check" style={{ alignItems: 'flex-start' }}>
                <input
                  type="checkbox"
                  checked={status.connection.pushPurchases}
                  onChange={async (e) => {
                    try {
                      const c = await api<{ pushPurchases: boolean }>('/integrations/foodics', { method: 'PATCH', body: { pushPurchases: e.target.checked } });
                      setData({ ...status, connection: { ...status.connection, pushPurchases: c.pushPurchases } });
                    } catch (err) {
                      setError((err as ApiError).message);
                    }
                  }}
                />
                <span>
                  {t('recordPurchases')}
                  <div className="faint" style={{ fontSize: 12 }}>
                    {t('recordPurchasesHint')}
                  </div>
                </span>
              </label>
            )}
          </>
        )}
      </section>

      {status?.connected && (
        <>
          <div className="segmented" role="tablist" style={{ overflowX: 'auto', maxWidth: '100%', alignSelf: 'flex-start' }}>
            {(['branches', 'items', 'menu', 'sales', 'purchases'] as Tab[]).map((x) => (
              <button key={x} role="tab" aria-pressed={tab === x} onClick={() => setTab(x)}>
                {t(`tab${x[0]!.toUpperCase()}${x.slice(1)}` as TKey)}
              </button>
            ))}
          </div>
          {tab === 'branches' && <Branches key={version} manage={manage} onChanged={reload} onError={setError} />}
          {tab === 'items' && <Items key={version} manage={manage} onChanged={reload} onError={setError} />}
          {tab === 'menu' && <Menu key={version} />}
          {tab === 'sales' && <Sales key={version} />}
          {tab === 'purchases' && <Purchases key={version} manage={manage} onError={setError} />}
        </>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function Branches({ manage, onChanged, onError }: { manage: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const { data: rows, setData } = useApi<PosLocation[]>('/integrations/foodics/locations');
  const { data: sites } = useApi<Site[]>('/sites');
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('foodicsBranch')}</th>
            <th>{t('backhouseSite')}</th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((l) => (
            <tr key={l.id}>
              <td>
                <div style={{ fontWeight: 500 }}>{pick(l)}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {l.kind === 'warehouse' ? t('warehouse') : (l.reference ?? '')}
                  {l.mappedBy === 'auto' && ` · ${t('matchedAuto')}`}
                </div>
              </td>
              <td>
                {manage ? (
                  <select
                    className="select"
                    value={l.siteId ?? ''}
                    aria-label={`${t('backhouseSite')} · ${pick(l)}`}
                    onChange={async (e) => {
                      try {
                        const siteId = e.target.value || null;
                        await api(`/integrations/foodics/locations/${l.id}`, { method: 'PUT', body: { siteId } });
                        const site = sites?.find((s) => s.id === siteId);
                        setData(rows.map((r) => (r.id === l.id ? { ...r, siteId, siteName: site?.name ?? null, siteNameAr: site?.nameAr ?? null, mappedBy: siteId ? 'human' : null } : r)));
                        onChanged();
                      } catch (err) {
                        onError((err as ApiError).message);
                      }
                    }}
                  >
                    <option value="">{t('posNotLinked')}</option>
                    {sites?.map((s) => (
                      <option key={s.id} value={s.id}>
                        {pick(s)}
                      </option>
                    ))}
                  </select>
                ) : l.siteName ? (
                  pick({ name: l.siteName, nameAr: l.siteNameAr })
                ) : (
                  <span className="faint">{t('posNotLinked')}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Items({ manage, onChanged, onError }: { manage: boolean; onChanged: () => void; onError: (m: string) => void }) {
  const { t, pick, lang } = useI18n();
  const { api } = useSession();
  const [unmappedOnly, setUnmappedOnly] = useState(false);
  const { data: rows, reload } = useApi<PosItem[]>(`/integrations/foodics/items?filter=${unmappedOnly ? 'unmapped' : 'all'}`, [unmappedOnly]);
  const { data: ours } = useApi<StockItem[]>('/stock-items');
  const save = async (p: PosItem, itemId: string | null, manualFactor?: number | null) => {
    try {
      await api(`/integrations/foodics/items/${p.id}`, { method: 'PUT', body: { itemId, ...(manualFactor !== undefined ? { manualFactor } : {}) } });
      reload();
      onChanged();
    } catch (err) {
      onError((err as ApiError).message);
    }
  };
  return (
    <>
      <div className="filters">
        <button className="chip" aria-pressed={unmappedOnly} onClick={() => setUnmappedOnly(!unmappedOnly)}>
          {t('unmappedOnly')}
        </button>
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('foodicsItem')}</th>
              <th>{t('backhouseItem')}</th>
            </tr>
          </thead>
          <tbody>
            {rows?.map((p) => (
              <tr key={p.id}>
                <td>
                  <div style={{ fontWeight: 500 }}>{pick(p)}</div>
                  <div className="faint num" style={{ fontSize: 12 }}>
                    {[p.sku, p.storageUnit && `${p.storageUnit}${p.ingredientUnit && p.storageFactor ? ` = ${Number(p.storageFactor)} ${p.ingredientUnit}` : ''}`].filter(Boolean).join(' · ')}
                  </div>
                </td>
                <td>
                  <div style={{ display: 'grid', gap: 6 }}>
                    {manage ? (
                      <select className="select" value={p.itemId ?? ''} onChange={(e) => save(p, e.target.value || null)} aria-label={`${t('backhouseItem')} · ${pick(p)}`}>
                        <option value="">{t('posNotLinked')}</option>
                        {ours?.map((i) => (
                          <option key={i.id} value={i.id}>
                            {pick(i)}
                          </option>
                        ))}
                      </select>
                    ) : p.itemName ? (
                      pick({ name: p.itemName, nameAr: p.itemNameAr })
                    ) : (
                      <span className="faint">{t('posNotLinked')}</span>
                    )}
                    {!p.itemId && p.suggestion && manage && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {t('suggested')}: {pick({ name: p.suggestion.name, nameAr: p.suggestion.nameAr })}{' '}
                        <button className="link-btn" onClick={() => save(p, p.suggestion!.itemId)}>
                          {t('useSuggestion')}
                        </button>
                      </div>
                    )}
                    {p.itemId && p.mappedBy === 'auto' && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {t('matchedAuto')}
                      </div>
                    )}
                    {p.itemId && !p.storageInBase && p.baseUnit && <FactorInput item={p} canEdit={manage} onSave={(f) => save(p, p.itemId, f)} />}
                    {p.itemId && p.storageInBase && p.manualFactor && p.baseUnit && (
                      <div className="faint num" style={{ fontSize: 12 }}>
                        1 {p.storageUnit} = {Number(p.storageInBase)} {unitLabel(p.baseUnit, lang)}
                      </div>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/** For items whose Foodics unit can't be converted: how much of our base unit is one Foodics storage unit. */
function FactorInput({ item, canEdit, onSave }: { item: PosItem; canEdit: boolean; onSave: (f: number) => void }) {
  const { t, lang } = useI18n();
  const [v, setV] = useState('');
  const n = readNumber(v);
  return (
    <div className="cell-flag" style={{ fontSize: 12, display: 'grid', gap: 4 }}>
      <span>
        {t('unitsDontMatch')} {item.storageUnit ?? ''}
      </span>
      {canEdit && (
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input className="input num" style={{ width: 90 }} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} aria-label={t('oneUnitIs').replace('{unit}', item.storageUnit ?? '')} />
          <span className="muted">{unitLabel(item.baseUnit!, lang)}</span>
          <button className="btn btn-sm btn-primary" disabled={!(n > 0)} onClick={() => onSave(n)}>
            {t('save')}
          </button>
        </span>
      )}
    </div>
  );
}

function Menu() {
  const { t, pick, fmtMoney } = useI18n();
  const { can } = useSession();
  const { data: rows } = useApi<PosProduct[]>('/integrations/foodics/products');
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('name')}</th>
            <th className="end">{t('price')}</th>
            <th className="end">{t('sold7')}</th>
            {can('price:read') && <th className="end hide-phone">{t('netSales')}</th>}
          </tr>
        </thead>
        <tbody>
          {rows?.map((p) => (
            <tr key={p.id}>
              <td>
                <div style={{ fontWeight: 500 }}>{pick(p)}</div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {[p.category, p.hasPosRecipe ? t('hasRecipe') : null].filter(Boolean).join(' · ')}
                </div>
              </td>
              <td className="end num">{p.price ? fmtMoney(p.price) : '–'}</td>
              <td className="end num">{Number(p.soldQty)}</td>
              {can('price:read') && <td className="end num hide-phone">{fmtMoney(p.soldNet ?? 0)}</td>}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Sales() {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const { can } = useSession();
  const { data: sites } = useApi<Site[]>('/sites');
  const [siteId, setSiteId] = useState('');
  const [days, setDays] = useState<7 | 30>(7);
  const range = useMemo(() => ({ from: new Date(Date.now() - (days - 1) * 86400_000).toISOString().slice(0, 10), to: new Date().toISOString().slice(0, 10) }), [days]);
  const { data } = useApi<PosSales>(`/integrations/foodics/sales?from=${range.from}&to=${range.to}${siteId ? `&siteId=${siteId}` : ''}`, [range, siteId]);
  const showMoney = can('price:read');
  const byDate = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of data?.days ?? []) m.set(d.date, (m.get(d.date) ?? 0) + Number(showMoney ? d.net : d.qty));
    return [...m].sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [data, showMoney]);
  const max = Math.max(1, ...byDate.map(([, v]) => v));
  return (
    <>
      <div className="filters">
        <select className="select" style={{ flex: '0 1 240px' }} value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label={t('site')}>
          <option value="">{t('allSites')}</option>
          {sites?.map((s) => (
            <option key={s.id} value={s.id}>
              {pick(s)}
            </option>
          ))}
        </select>
        <div className="segmented" role="group">
          {([7, 30] as const).map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
              {t(d === 7 ? 'wasteLast7' : 'wasteLast30')}
            </button>
          ))}
        </div>
      </div>
      {data && data.days.length === 0 ? (
        <div className="card">
          <Empty title={t('noSales')} />
        </div>
      ) : (
        <div className="split-2">
          <section className="card" style={{ gap: 10 }}>
            <div className="card-title" style={{ fontSize: 15 }}>
              {showMoney ? `${t('netSales')} · ${fmtMoney(data?.total.net ?? 0)}` : t('tabSales')}
            </div>
            <div className="bar-list">
              {byDate.map(([date, v]) => (
                <div key={date} className="bar-row">
                  <div className="bar-row-head">
                    <span className="num">{fmtDate(date)}</span>
                    <span className="num muted">{showMoney ? fmtMoney(v) : v}</span>
                  </div>
                  <div className="bar-track accent">
                    <span style={{ width: `${(v / max) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="card" style={{ gap: 10 }}>
            <div className="card-title" style={{ fontSize: 15 }}>
              {t('bestSellers')}
            </div>
            <div className="bar-list">
              {data?.products.map((p) => (
                <div key={p.productId} className="bar-row-head" style={{ fontSize: 14 }}>
                  <span>
                    {p.name ? pick({ name: p.name, nameAr: p.nameAr }) : p.productId} <span className="faint num">× {Number(p.qty)}</span>
                  </span>
                  {showMoney && <span className="num muted">{fmtMoney(p.net ?? 0)}</span>}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}
    </>
  );
}

function Purchases({ manage, onError }: { manage: boolean; onError: (m: string) => void }) {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const { api, can } = useSession();
  const { data: rows, reload } = useApi<PosPush[]>('/integrations/foodics/pushes');
  if (rows && rows.length === 0)
    return (
      <div className="card">
        <Empty title={t('noPurchases')} body={t('noPurchasesBody')} />
      </div>
    );
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('receipts')}</th>
            <th className="hide-phone">{t('site')}</th>
            {can('price:read') && <th className="end hide-phone">{t('total')}</th>}
            <th>{t('status')}</th>
          </tr>
        </thead>
        <tbody>
          {rows?.map((p) => (
            <tr key={p.id}>
              <td>
                <div className="num" style={{ fontWeight: 600 }}>
                  <bdi>{p.grnNumber ?? '–'}</bdi>
                </div>
                <div className="faint" style={{ fontSize: 12 }}>
                  {p.receivedAt ? fmtDate(p.receivedAt) : ''}
                  {p.externalReference ? ` · Foodics ${p.externalReference}` : ''}
                </div>
              </td>
              <td className="hide-phone muted">{p.siteName ? pick({ name: p.siteName, nameAr: p.siteNameAr }) : '–'}</td>
              {can('price:read') && <td className="end num hide-phone">{p.total ? fmtMoney(p.total) : '–'}</td>}
              <td>
                <span className={`tag ${p.status === 'pushed' ? 'tag-accent' : p.status === 'pending' ? '' : 'tag-late'}`}>
                  <span className="dot" />
                  {t(`push_${p.status}` as TKey)}
                </span>
                {p.error && p.status !== 'pushed' && (
                  <div className="faint" style={{ fontSize: 12, marginTop: 4, maxWidth: 360 }}>
                    {p.error}
                  </div>
                )}
                {manage && (p.status === 'failed' || p.status === 'needs_mapping') && (
                  <button
                    className="link-btn"
                    style={{ fontSize: 12 }}
                    onClick={async () => {
                      try {
                        await api(`/integrations/foodics/pushes/${p.id}/retry`, { method: 'POST' });
                        reload();
                      } catch (err) {
                        onError((err as ApiError).message);
                      }
                    }}
                  >
                    {t('retry')}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
