'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useSession } from '@/lib/session';
import type { Candidate } from '@/lib/types';
import { Dialog } from './ui';
import { IconSearch } from './icons';

export const CATEGORIES = [
  'produce', 'meat', 'poultry', 'seafood', 'dairy', 'eggs', 'bakery', 'dry_goods', 'grains',
  'oils_fats', 'spices', 'sauces', 'beverages', 'frozen', 'packaging', 'cleaning', 'other',
] as const;
export const ALLERGENS = [
  'gluten', 'crustaceans', 'eggs', 'fish', 'peanuts', 'soy', 'milk', 'tree_nuts',
  'celery', 'mustard', 'sesame', 'sulphites', 'lupin', 'molluscs',
] as const;
export const UNITS_BY_BASE: Record<string, string[]> = {
  g: ['g', 'kg', 'mg', 'oz', 'lb'],
  ml: ['ml', 'l', 'cl', 'fl_oz', 'gal'],
  each: ['each', 'dozen'],
};
export const ALL_UNITS = ['g', 'kg', 'mg', 'oz', 'lb', 'ml', 'l', 'cl', 'fl_oz', 'gal', 'each', 'dozen'];

export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

/** Percentage change tag: up = late colour (costs more), down = accent. */
export function ChangeTag({ pct }: { pct: number | null | undefined }) {
  const { fmtNum } = useI18n();
  if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
  const up = pct > 0;
  return (
    <span className={`tag num ${up ? 'tag-late' : 'tag-accent'}`} dir="ltr">
      {up ? '+' : ''}
      {fmtNum(pct, 1)}%
    </span>
  );
}

export function MatchTag({ source, label }: { source: 'auto' | 'human' | null; label: string | null }) {
  const { t } = useI18n();
  if (!label) return <span className="tag tag-late">{t('noMatch')}</span>;
  return (
    <span className="tag tag-accent" title={source === 'auto' ? t('matchAuto') : t('matchHuman')}>
      <span className="dot" style={{ opacity: source === 'auto' ? 0.45 : 1 }} />
      {label}
    </span>
  );
}

export function candidateName(c: { nameEn: string; nameAr: string }, lang: string) {
  return lang === 'ar' ? c.nameAr : c.nameEn;
}

/** Search the shared ingredient map and pick one (or "none"). */
export function IngredientPicker({
  initial = '',
  onPick,
  onClose,
}: {
  initial?: string;
  onPick: (c: Candidate | null) => Promise<void> | void;
  onClose: () => void;
}) {
  const { t, lang } = useI18n();
  const { api } = useSession();
  const [q, setQ] = useState(initial);
  const dq = useDebounced(q);
  const [results, setResults] = useState<Candidate[]>([]);
  useEffect(() => {
    api<Candidate[]>(`/canonical-ingredients?q=${encodeURIComponent(dq)}&limit=12`).then(setResults).catch(() => setResults([]));
  }, [api, dq]);
  return (
    <Dialog title={t('ingredientMatch')} onClose={onClose}>
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {t('ingredientHint')}
      </p>
      <div style={{ position: 'relative' }}>
        <IconSearch style={{ position: 'absolute', insetInlineStart: 14, top: 14, color: 'var(--t3)' }} />
        <input className="input" style={{ paddingInlineStart: 44 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchIngredients')} />
      </div>
      <div style={{ display: 'grid', gap: 6, maxHeight: 360, overflowY: 'auto' }}>
        {results.map((c: any) => (
          <button
            key={c.canonicalId ?? c.id}
            className="btn btn-quiet"
            style={{ justifyContent: 'space-between' }}
            onClick={() => onPick({ ...c, canonicalId: c.canonicalId ?? c.id })}
          >
            <span>
              {candidateName(c, lang)} <span className="faint" style={{ fontWeight: 400 }}>· {lang === 'ar' ? c.nameEn : c.nameAr}</span>
            </span>
            <span className="tag">{t(`cat_${c.category}` as TKey)}</span>
          </button>
        ))}
        <button className="btn btn-danger" onClick={() => onPick(null)}>
          {t('noMatchOption')}
        </button>
      </div>
    </Dialog>
  );
}

interface ImportResult {
  dryRun: boolean;
  summary: Record<string, number>;
  results: { row: number; action: string; name?: string; label?: string; errors: string[]; match?: { slug: string; nameEn: string } | null; oldPrice?: string; newPrice?: string; changePct?: number | null }[];
}

/** CSV import: paste or choose a file, check (dry run), then import (all or nothing). */
export function ImportDialog({ title, endpoint, columnsHint, onClose, onDone }: { title: string; endpoint: string; columnsHint: string; onClose: () => void; onDone: () => void }) {
  const { t, fmtMoney } = useI18n();
  const { api } = useSession();
  const [csv, setCsv] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const r = await api<ImportResult>(endpoint, { method: 'POST', body: { csv, dryRun } });
      if (dryRun) setResult(r);
      else {
        onDone();
        onClose();
      }
    } catch (e) {
      const err = e as ApiError;
      if (err.body?.results) setResult({ dryRun: true, summary: {}, results: err.body.results });
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const hasErrors = result?.results.some((r) => r.action === 'error');
  return (
    <Dialog
      title={title}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-quiet" disabled={!csv || busy} onClick={() => run(true)}>
            {t('preview')}
          </button>
          <button className="btn btn-primary" disabled={!result || hasErrors || busy} onClick={() => run(false)}>
            {t('confirmImport')}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0, fontSize: 13 }}>
        {t('importHint')}
        <br />
        <span dir="ltr" className="faint">
          {columnsHint}
        </span>
      </p>
      <div style={{ display: 'flex', gap: 8 }}>
        <button className="btn btn-sm btn-quiet" onClick={() => file.current?.click()}>
          {t('chooseFile')}
        </button>
        <input
          ref={file}
          type="file"
          accept=".csv,text/csv"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            if (f) {
              setCsv(await f.text());
              setResult(null);
            }
          }}
        />
      </div>
      <textarea
        className="input"
        style={{ minHeight: 120, padding: 12, fontFamily: 'ui-monospace, monospace', fontSize: 13 }}
        dir="ltr"
        value={csv}
        onChange={(e) => {
          setCsv(e.target.value);
          setResult(null);
        }}
      />
      {error && <div className="notice notice-error">{hasErrors ? t('importErrors') : error}</div>}
      {result && (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {Object.entries(result.summary).map(([k, n]) => (
              <span key={k} className={`tag ${k === 'error' && n ? 'tag-late' : ''}`}>
                {t(`a_${k}` as TKey)}: {n}
              </span>
            ))}
          </div>
          <div className="table-wrap" style={{ maxHeight: 280 }}>
            <table className="table">
              <thead>
                <tr>
                  <th>{t('row')}</th>
                  <th>{t('name')}</th>
                  <th>{t('result')}</th>
                </tr>
              </thead>
              <tbody>
                {result.results.map((r) => (
                  <tr key={r.row}>
                    <td className="num faint">{r.row}</td>
                    <td>{r.name ?? r.label}</td>
                    <td>
                      <span className={`tag ${r.action === 'error' ? 'tag-late' : r.action === 'create' || r.action === 'price' ? 'tag-accent' : ''}`}>
                        {t(`a_${r.action}` as TKey)}
                      </span>{' '}
                      {r.errors.length > 0 && <span className="field-error">{r.errors.join('; ')}</span>}
                      {r.match && <span className="faint"> → {r.match.nameEn}</span>}
                      {r.newPrice && (
                        <span className="num faint">
                          {' '}
                          {r.oldPrice ? `${fmtMoney(r.oldPrice)} → ` : ''}
                          {fmtMoney(r.newPrice)} <ChangeTag pct={r.changePct} />
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}

/** Download a CSV endpoint through the authenticated proxy. */
export async function downloadCsv(api: ReturnType<typeof useSession>['api'], path: string, filename: string) {
  const text = await api<string>(path, { raw: true });
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
