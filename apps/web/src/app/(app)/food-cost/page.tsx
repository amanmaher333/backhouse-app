'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Fragment, Suspense, useEffect, useMemo, useState } from 'react';
import { Empty, PageHead } from '@/components/ui';
import { RecipeTabs } from '@/components/stock';
import { useI18n } from '@/lib/i18n';
import { useApi, useSession } from '@/lib/session';
import type { Site } from '@/lib/types';
import type { CountPeriod, FoodCostReport, FoodCostRow } from '@/lib/types-foodcost';

type Preset = 'yesterday' | '7' | 'counts' | 'custom';
const today = () => new Date().toISOString().slice(0, 10);
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

export default function FoodCostPage() {
  return (
    <Suspense>
      <FoodCost />
    </Suspense>
  );
}

function FoodCost() {
  const { t, pick, fmtMoney, fmtQty, fmtDate } = useI18n();
  const { can } = useSession();
  const { data: sites } = useApi<Site[]>('/sites');
  // A link can open a site and dates (e.g. from the Cost Controller's weekly report).
  const params = useSearchParams();
  const linked = params.get('from') && params.get('to');
  const [siteId, setSiteId] = useState(params.get('siteId') ?? '');
  const [preset, setPreset] = useState<Preset>(linked ? 'custom' : '7');
  const [from, setFrom] = useState(params.get('from') ?? shift(today(), -7));
  const [to, setTo] = useState(params.get('to') ?? shift(today(), -1));
  const [endCountId, setEndCountId] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    if (!siteId && sites?.[0]) setSiteId(sites[0].id);
  }, [sites, siteId]);
  const { data: counts } = useApi<CountPeriod[]>(siteId ? `/food-cost/periods?siteId=${siteId}` : null, [siteId]);
  useEffect(() => {
    if (counts && counts.length >= 2 && !endCountId) setEndCountId(counts[0]!.id);
  }, [counts, endCountId]);

  const query = useMemo(() => {
    if (!siteId) return null;
    if (preset === 'counts') {
      const i = counts?.findIndex((c) => c.id === endCountId) ?? -1;
      const start = i >= 0 ? counts?.[i + 1] : undefined;
      return start ? `siteId=${siteId}&fromCountId=${start.id}&toCountId=${endCountId}` : null;
    }
    if (preset === 'yesterday') return `siteId=${siteId}&from=${shift(today(), -1)}&to=${shift(today(), -1)}`;
    if (preset === '7') return `siteId=${siteId}&from=${shift(today(), -7)}&to=${shift(today(), -1)}`;
    return from && to ? `siteId=${siteId}&from=${from}&to=${to}` : null;
  }, [siteId, preset, counts, endCountId, from, to]);
  const { data: r, error } = useApi<FoodCostReport>(query ? `/food-cost?${query}` : null, [query]);
  const showCost = can('price:read');

  return (
    <div className="page">
      <PageHead title={t('foodCostTab')} sub={t('foodCostSub')} />
      <RecipeTabs />
      <div className="filters">
        {sites && sites.length > 1 && (
          <select className="select" style={{ flex: '0 1 220px' }} value={siteId} onChange={(e) => { setSiteId(e.target.value); setEndCountId(''); }} aria-label={t('site')}>
            {sites.map((s) => (
              <option key={s.id} value={s.id}>
                {pick(s)}
              </option>
            ))}
          </select>
        )}
        <div className="segmented" role="group" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {(['yesterday', '7', 'counts', 'custom'] as Preset[]).map((p) => (
            <button key={p} aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {t(p === 'yesterday' ? 'periodYesterday' : p === '7' ? 'period7' : p === 'counts' ? 'periodCounts' : 'periodCustom')}
            </button>
          ))}
        </div>
      </div>
      {preset === 'custom' && (
        <div className="filters">
          <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {t('fromLabel')} <input className="input" type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} />
          </label>
          <label className="muted" style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            {t('toLabel')} <input className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
          </label>
        </div>
      )}
      {preset === 'counts' &&
        (counts && counts.length >= 2 ? (
          <div className="filters">
            <label className="muted" style={{ display: 'grid', gap: 4, flex: '1 1 100%', minWidth: 0, maxWidth: 480 }}>
              {t('periodCounts')}
              <select className="select" style={{ width: '100%', minWidth: 0 }} value={endCountId} onChange={(e) => setEndCountId(e.target.value)}>
                {counts.slice(0, -1).map((c, i) => (
                  <option key={c.id} value={c.id}>
                    {counts[i + 1]!.ref} ({fmtDate(counts[i + 1]!.date)}) – {c.ref} ({fmtDate(c.date)})
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : (
          <div className="notice">{t('needTwoCounts')}</div>
        ))}
      {error && <div className="notice notice-error">{error.message}</div>}

      {r && (
        <>
          <div className="faint num" style={{ fontSize: 13 }}>
            {fmtDate(r.period.from)} – {fmtDate(r.period.to)}
            {r.counts.start && r.counts.end ? ` · ${r.counts.start.ref} – ${r.counts.end.ref}` : ''}
          </div>
          {!r.pos.connected && <div className="notice notice-info">{t('noPos')}</div>}
          {!r.counts.start && <div className="notice">{t('noCountStart')}</div>}
          {!r.counts.end && <div className="notice">{t('noCountEnd')}</div>}
          {r.pos.unlinkedLocations > 0 && (
            <div className="notice">
              {t('unlinkedLocations')}: <span className="num">{r.pos.unlinkedLocations}</span> · <Link href="/integrations">{t('integrations')}</Link>
            </div>
          )}

          {r.totals && (
            <div className="stats">
              <div className="stat">
                <div className="stat-label">{t('netSales')}</div>
                <div className="stat-value" style={{ fontSize: 22 }}>
                  {fmtMoney(r.totals.netSales)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('actualFoodCost')}</div>
                <div className="stat-value">{r.totals.actualPct ? `${r.totals.actualPct}%` : '–'}</div>
                <div className="faint num" style={{ fontSize: 12 }}>
                  {fmtMoney(r.totals.actualCost)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('theoreticalFoodCost')}</div>
                <div className="stat-value">{r.totals.theoreticalPct ? `${r.totals.theoreticalPct}%` : '–'}</div>
                <div className="faint num" style={{ fontSize: 12 }}>
                  {fmtMoney(r.totals.theoreticalCost)}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">{t('gap')}</div>
                <div className={`stat-value ${Number(r.totals.gapPct ?? 0) > 0 ? 'cell-flag' : ''}`}>{r.totals.gapPct !== null ? `${Number(r.totals.gapPct) > 0 ? '+' : ''}${r.totals.gapPct} ${t('points')}` : '–'}</div>
                <div className="faint num" style={{ fontSize: 12 }}>
                  {t('unexplained')} {fmtMoney(r.totals.varianceCost)}
                </div>
              </div>
            </div>
          )}

          {r.withoutRecipe.length > 0 && (
            <section className="card" style={{ gap: 8 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div className="card-title" style={{ fontSize: 15 }}>
                  {t('withoutRecipeTitle')}
                </div>
                <Link href="/recipes" className="link-btn">
                  {t('fixRecipes')}
                </Link>
              </div>
              <div className="faint" style={{ fontSize: 13 }}>
                {t('withoutRecipeBody')}
              </div>
              <div className="bar-list">
                {r.withoutRecipe.map((w) => (
                  <div key={w.productId} className="bar-row-head" style={{ fontSize: 14 }}>
                    <span>
                      {w.name} <span className="faint num">× {Number(w.qty)}</span>
                    </span>
                    {showCost && w.net && <span className="num muted">{fmtMoney(w.net)}</span>}
                  </div>
                ))}
              </div>
            </section>
          )}
          {r.noCost.length > 0 && (
            <div className="notice">
              {t('noCostTitle')}: {r.noCost.join(', ')}
            </div>
          )}

          {r.rows.length === 0 ? (
            <div className="card">
              <Empty title={t('noFoodCostRows')} />
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t('item')}</th>
                    <th className="end">{t('used')}</th>
                    <th className="end hide-phone">
                      {t('shouldHaveUsed')}
                      <div className="faint" style={{ fontWeight: 400 }}>
                        {t('soldWaste')}
                      </div>
                    </th>
                    <th className="end">{t('varianceCol')}</th>
                  </tr>
                </thead>
                <tbody>
                  {r.rows.map((row) => (
                    <Fragment key={row.itemId}>
                      <tr onClick={() => setOpen(open === row.itemId ? null : row.itemId)} style={{ cursor: 'pointer' }}>
                        <td>
                          <div style={{ fontWeight: 500 }}>{pick(row)}</div>
                          {Number(row.varianceValue ?? row.variance) > 0 && (
                            <div className="cell-flag" style={{ fontSize: 12 }}>
                              {t('overUsed')}
                            </div>
                          )}
                        </td>
                        <td className="end num">{fmtQty(row.actual, row.baseUnit)}</td>
                        <td className="end num hide-phone">
                          {fmtQty(row.theoretical, row.baseUnit)}
                          <div className="faint" style={{ fontSize: 12 }}>
                            {fmtQty(row.sold, row.baseUnit)} + {fmtQty(row.waste, row.baseUnit)}
                          </div>
                        </td>
                        <td className="end num">
                          <span className={Number(row.variance) > 0 ? 'cell-flag' : ''}>
                            {Number(row.variance) > 0 ? '+' : ''}
                            {fmtQty(row.variance, row.baseUnit)}
                          </span>
                          {showCost && row.varianceValue && (
                            <div className="faint" style={{ fontSize: 12 }}>
                              {fmtMoney(row.varianceValue)}
                            </div>
                          )}
                        </td>
                      </tr>
                      {open === row.itemId && <BreakdownRow row={row} />}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function BreakdownRow({ row }: { row: FoodCostRow }) {
  const { t, fmtQty } = useI18n();
  const q = (v: string) => fmtQty(v, row.baseUnit);
  return (
    <tr>
      <td colSpan={4} className="faint num" style={{ fontSize: 13, background: 'var(--tile)' }}>
        {t('breakdown').replace('{o}', q(row.opening)).replace('{r}', q(row.received)).replace('{i}', q(row.transferIn)).replace('{x}', q(row.transferOut)).replace('{c}', q(row.closing))} = {q(row.actual)}
      </td>
    </tr>
  );
}
