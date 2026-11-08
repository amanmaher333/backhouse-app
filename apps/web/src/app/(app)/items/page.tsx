'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog, Empty, Field, PageHead } from '@/components/ui';
import { IconDownload, IconPlus, IconSearch, IconUpload } from '@/components/icons';
import { CATEGORIES, ImportDialog, MatchTag, candidateName, downloadCsv, useDebounced } from '@/components/catalog';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Candidate, ItemRow, MatchResult } from '@/lib/types';

export default function ItemsPage() {
  const { t, pick, lang, fmtUnitCost } = useI18n();
  const { api, can } = useSession();
  const [q, setQ] = useState('');
  const [category, setCategory] = useState('');
  const [unmatched, setUnmatched] = useState(false);
  const [showInactive, setShowInactive] = useState(false);
  const dq = useDebounced(q);
  const params = new URLSearchParams({ limit: '500', active: showInactive ? 'all' : 'true' });
  if (dq) params.set('q', dq);
  if (category) params.set('category', category);
  if (unmatched) params.set('unmatched', 'true');
  const { data: items, reload } = useApi<ItemRow[]>(`/items?${params}`, [params.toString()]);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const canManage = can('item:manage');
  const showPrices = can('price:read');
  const filtered = !!(dq || category || unmatched);

  return (
    <div className="page">
      <PageHead
        title={t('items')}
        sub={t('itemsSub')}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn btn-quiet" onClick={() => downloadCsv(api, '/items/export', 'items.csv')}>
              <IconDownload /> {t('exportCsv')}
            </button>
            {canManage && (
              <button className="btn btn-quiet" onClick={() => setImporting(true)}>
                <IconUpload /> {t('importCsv')}
              </button>
            )}
            {canManage && (
              <button className="btn btn-primary" onClick={() => setAdding(true)}>
                <IconPlus /> {t('addItem')}
              </button>
            )}
          </div>
        }
      />

      <div className="filters">
        <div style={{ position: 'relative', flex: '1 1 260px' }}>
          <IconSearch style={{ position: 'absolute', insetInlineStart: 14, top: 14, color: 'var(--t3)' }} />
          <input className="input" style={{ paddingInlineStart: 44 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchItems')} aria-label={t('searchItems')} />
        </div>
        <select className="select" style={{ flex: '0 1 220px' }} value={category} onChange={(e) => setCategory(e.target.value)} aria-label={t('category')}>
          <option value="">{t('allCategories')}</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {t(`cat_${c}` as TKey)}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={unmatched} onChange={(e) => setUnmatched(e.target.checked)} />
          {t('unmatchedOnly')}
        </label>
        <label className="check">
          <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
          {t('inactiveItems')}
        </label>
      </div>

      {items && items.length === 0 && !filtered ? (
        <div className="card">
          <Empty
            title={t('noItems')}
            body={t('noItemsBody')}
            action={
              canManage && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-quiet" onClick={() => setImporting(true)}>
                    {t('importCsv')}
                  </button>
                  <button className="btn btn-primary" onClick={() => setAdding(true)}>
                    {t('addItem')}
                  </button>
                </div>
              )
            }
          />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th className="hide-phone">{t('category')}</th>
                <th className="hide-phone">{t('ingredient')}</th>
                <th className="end hide-phone">{t('suppliers')}</th>
                {showPrices && <th className="end">{t('bestCost')}</th>}
              </tr>
            </thead>
            <tbody>
              {items?.map((i) => (
                <tr key={i.id} style={{ opacity: i.isActive ? 1 : 0.55 }}>
                  <td>
                    <Link href={`/items/${i.id}`} style={{ color: 'inherit', display: 'block' }}>
                      <div style={{ fontWeight: 500 }}>{pick(i)}</div>
                      <div className="faint num" style={{ fontSize: 12 }}>
                        {i.code}
                        {lang === 'ar' && i.nameAr ? ` · ${i.name}` : i.nameAr && lang === 'en' ? ` · ${i.nameAr}` : ''}
                      </div>
                    </Link>
                  </td>
                  <td className="hide-phone">
                    <span className="tag">{t(`cat_${i.category}` as TKey)}</span>
                  </td>
                  <td className="hide-phone">
                    <MatchTag
                      source={i.canonicalSource}
                      label={i.canonicalId ? (lang === 'ar' ? i.canonicalNameAr : i.canonicalNameEn) : null}
                    />
                  </td>
                  <td className="end num hide-phone">{i.supplierCount}</td>
                  {showPrices && <td className="end num">{i.bestCostPerBase ? fmtUnitCost(i.bestCostPerBase, i.baseUnit) : '–'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {adding && <AddItemDialog onClose={() => setAdding(false)} />}
      {importing && (
        <ImportDialog title={t('importTitle')} endpoint="/items/import" columnsHint={t('itemsCsvColumns')} onClose={() => setImporting(false)} onDone={reload} />
      )}
    </div>
  );
}

function AddItemDialog({ onClose }: { onClose: () => void }) {
  const { t, lang } = useI18n();
  const { api } = useSession();
  const router = useRouter();
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [category, setCategory] = useState<string>('');
  const [baseUnit, setBaseUnit] = useState<string>('');
  const [choice, setChoice] = useState<'auto' | 'none' | string>('auto');
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [dups, setDups] = useState<{ id: string; name: string; code: string }[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dname = useDebounced(`${name} ${nameAr}`.trim(), 350);

  useEffect(() => {
    if (!dname) {
      setMatch(null);
      setDups([]);
      return;
    }
    api<MatchResult[]>('/catalog/match', { method: 'POST', body: { names: [dname] } })
      .then((r) => setMatch(r[0] ?? null))
      .catch(() => setMatch(null));
    if (name.trim()) api<any[]>(`/items/duplicates?name=${encodeURIComponent(name.trim())}`).then(setDups).catch(() => setDups([]));
  }, [api, dname, name]);

  const chosen: Candidate | null =
    choice === 'none' ? null : choice === 'auto' ? (match?.auto ?? null) : (match?.candidates.find((c) => c.canonicalId === choice) ?? null);
  const effUnit = baseUnit || chosen?.baseUnit || '';
  const effCategory = category || chosen?.category || '';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, unknown> = {
        name: name.trim(),
        nameAr: nameAr.trim() || null,
        baseUnit: effUnit || undefined,
        category: effCategory || undefined,
      };
      if (choice === 'none') body.canonicalId = null;
      else if (choice !== 'auto') body.canonicalId = choice;
      const item = await api<{ id: string }>('/items', { method: 'POST', body });
      router.push(`/items/${item.id}`);
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.fieldErrors());
      setError(err.body?.issues ? null : err.message);
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('addItem')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !name.trim() || !effUnit} onClick={submit}>
            {t('save')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <div className="form-row">
        <Field label={t('name')} error={errors.name}>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Tomato, Olive oil 5L…" />
        </Field>
        <Field label={t('nameAr')}>
          <input className="input" value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" lang="ar" />
        </Field>
      </div>

      {dups.length > 0 && (
        <div className="notice">
          {t('possibleDuplicate')}{' '}
          {dups.map((d, i) => (
            <span key={d.id}>
              {i > 0 && '، '}
              <Link href={`/items/${d.id}`}>{d.name}</Link>
            </span>
          ))}
        </div>
      )}

      {match && match.candidates.length > 0 && (
        <div className="field">
          <span>{t('suggestions')}</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {match.candidates.slice(0, 4).map((c) => {
              const selected = chosen?.canonicalId === c.canonicalId;
              return (
                <button
                  key={c.canonicalId}
                  type="button"
                  className="chip"
                  aria-pressed={selected}
                  onClick={() => setChoice(match.auto?.canonicalId === c.canonicalId ? 'auto' : c.canonicalId)}
                >
                  {candidateName(c, lang)}
                  <span className="faint num">{Math.round(c.score * 100)}%</span>
                </button>
              );
            })}
            <button type="button" className="chip" aria-pressed={choice === 'none' || (!chosen && choice === 'auto')} onClick={() => setChoice('none')}>
              {t('noMatchOption')}
            </button>
          </div>
          <span className="field-hint">{t('ingredientHint')}</span>
        </div>
      )}

      <div className="form-row">
        <Field label={t('baseUnit')} error={errors.baseUnit}>
          <select className="select" value={effUnit} onChange={(e) => setBaseUnit(e.target.value)}>
            <option value="" disabled>
              –
            </option>
            {(['g', 'ml', 'each'] as const).map((u) => (
              <option key={u} value={u}>
                {t(`u_${u}` as TKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('category')}>
          <select className="select" value={effCategory} onChange={(e) => setCategory(e.target.value)}>
            <option value="">{t('cat_other')}</option>
            {CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`cat_${c}` as TKey)}
              </option>
            ))}
          </select>
        </Field>
      </div>
    </Dialog>
  );
}
