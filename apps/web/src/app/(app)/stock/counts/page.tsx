'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Dialog, Empty, Field, PageHead } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { CountStatusTag } from '@/components/counts';
import { StockTabs } from '@/components/stock';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Site } from '@/lib/types';
import type { StockRow } from '@/lib/types-procurement';
import type { CountDetail, CountRow } from '@/lib/types-counts';

export default function CountsPage() {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const { can } = useSession();
  const router = useRouter();
  const { data: sites } = useApi<Site[]>('/sites');
  const [siteId, setSiteId] = useState('');
  const [status, setStatus] = useState<'active' | 'all'>('active');
  const [creating, setCreating] = useState(false);
  const { data: rows } = useApi<CountRow[]>(`/stock-counts?status=${status}${siteId ? `&siteId=${siteId}` : ''}`, [status, siteId]);

  return (
    <div className="page">
      <PageHead
        title={t('counts')}
        sub={t('countsSub')}
        action={
          can('stock:manage') && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <IconPlus /> {t('newCount')}
            </button>
          )
        }
      />
      <StockTabs />
      <div className="filters">
        <div className="segmented" role="group">
          {(['active', 'all'] as const).map((s) => (
            <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>
              {t(s === 'active' ? 'countsActive' : 'countsAll')}
            </button>
          ))}
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

      {rows && rows.length === 0 ? (
        <div className="card">
          <Empty title={t('noCounts')} body={t('noCountsBody')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('counts')}</th>
                <th className="hide-phone">{t('site')}</th>
                <th className="end">{t('progress')}</th>
                {can('price:read') && <th className="end hide-phone">{t('variance')}</th>}
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/stock/counts/${r.id}`} className="num" style={{ fontWeight: 600 }}>
                      <bdi>{r.ref}</bdi>
                    </Link>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {fmtDate(r.createdAt)} · {t(r.scope === 'full' ? 'fullCount' : 'partialCount')}
                      <span className="show-phone"> · {pick({ name: r.siteName, nameAr: r.siteNameAr })}</span>
                    </div>
                  </td>
                  <td className="hide-phone muted">{pick({ name: r.siteName, nameAr: r.siteNameAr })}</td>
                  <td className="end num">
                    {r.counted} / {r.lines}
                  </td>
                  {can('price:read') && <td className="end num hide-phone">{r.varianceValue ? fmtMoney(r.varianceValue) : '–'}</td>}
                  <td>
                    <CountStatusTag status={r.status} needsApproval={r.needsApproval} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && sites && (
        <NewCountDialog
          sites={sites}
          defaultSiteId={siteId || sites[0]?.id || ''}
          onClose={() => setCreating(false)}
          onDone={(c) => router.push(`/stock/counts/${c.id}`)}
        />
      )}
    </div>
  );
}

function NewCountDialog({ sites, defaultSiteId, onClose, onDone }: { sites: Site[]; defaultSiteId: string; onClose: () => void; onDone: (c: CountDetail) => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const [siteId, setSiteId] = useState(defaultSiteId);
  const [scope, setScope] = useState<'full' | 'partial'>('full');
  const [blind, setBlind] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: stock } = useApi<StockRow[]>(scope === 'partial' && siteId ? `/sites/${siteId}/stock` : null, [scope, siteId]);
  useEffect(() => setPicked(new Set()), [siteId]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (stock ?? []).filter((r) => !needle || r.name.toLowerCase().includes(needle) || (r.nameAr ?? '').includes(needle) || (r.code ?? '').toLowerCase().includes(needle));
  }, [stock, q]);

  return (
    <Dialog
      title={t('newCount')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !siteId || (scope === 'partial' && picked.size === 0)}
            onClick={async () => {
              setBusy(true);
              try {
                onDone(await api<CountDetail>(`/sites/${siteId}/stock-counts`, { method: 'POST', body: { scope, blind, ...(scope === 'partial' ? { itemIds: [...picked] } : {}) } }));
              } catch (e) {
                setError((e as ApiError).message);
                setBusy(false);
              }
            }}
          >
            {t('startCount')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <Field label={t('site')}>
        <select className="select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
          {sites.map((s) => (
            <option key={s.id} value={s.id}>
              {pick(s)}
            </option>
          ))}
        </select>
      </Field>
      <div className="segmented" role="group" style={{ alignSelf: 'flex-start' }}>
        {(['full', 'partial'] as const).map((s) => (
          <button key={s} aria-pressed={scope === s} onClick={() => setScope(s)}>
            {t(s === 'full' ? 'fullCount' : 'partialCount')}
          </button>
        ))}
      </div>
      {scope === 'partial' && (
        <Field label={`${t('chooseItems')}${picked.size ? ` (${picked.size})` : ''}`}>
          <input className="input" type="search" placeholder={t('searchItems')} value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="pick-list">
            {shown.map((r) => (
              <label key={r.itemId} className="check">
                <input
                  type="checkbox"
                  checked={picked.has(r.itemId)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(r.itemId);
                    else next.delete(r.itemId);
                    setPicked(next);
                  }}
                />
                {pick(r)}
              </label>
            ))}
          </div>
        </Field>
      )}
      <label className="check">
        <input type="checkbox" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
        <span>
          {t('blindCount')}
          <div className="faint" style={{ fontSize: 12 }}>
            {t('blindCountHint')}
          </div>
        </span>
      </label>
    </Dialog>
  );
}
