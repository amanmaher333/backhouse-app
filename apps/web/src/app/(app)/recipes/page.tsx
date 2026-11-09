'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Dialog, Empty, PageHead, Toast } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { CostBasis, PosProductOption, RecipeRow } from '@/lib/types-recipes';

export default function RecipesPage() {
  const { t, pick, fmtMoney } = useI18n();
  const { can } = useSession();
  const [kind, setKind] = useState<'menu' | 'prep'>('menu');
  const [basis, setBasis] = useState<CostBasis>('supplier');
  const [q, setQ] = useState('');
  const [importing, setImporting] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const { data: rows, reload } = useApi<RecipeRow[]>(`/recipes?kind=${kind}&basis=${basis}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}`, [kind, basis, q]);
  const { data: posProducts, reload: reloadPos } = useApi<PosProductOption[]>(can('recipe:read') ? '/recipes/pos-products' : null);
  const manage = can('recipe:manage');
  const showCost = can('price:read');
  const withFoodicsRecipe = posProducts?.filter((p) => p.hasPosRecipe).length ?? 0;

  return (
    <div className="page">
      <PageHead
        title={t('recipes')}
        sub={t('recipesSub')}
        action={
          manage && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {withFoodicsRecipe > 0 && (
                <button className="btn btn-quiet" onClick={() => setImporting(true)}>
                  {t('fromFoodics')} <span className="num">({withFoodicsRecipe})</span>
                </button>
              )}
              <Link className="btn btn-primary" href={`/recipes/new?kind=${kind}`}>
                <IconPlus /> {t('newRecipe')}
              </Link>
            </div>
          )
        }
      />
      <div className="filters">
        <div className="segmented" role="group">
          {(['menu', 'prep'] as const).map((k) => (
            <button key={k} aria-pressed={kind === k} onClick={() => setKind(k)}>
              {t(k === 'menu' ? 'menuItems' : 'preps')}
            </button>
          ))}
        </div>
        <input className="input" type="search" placeholder={t('searchItems')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 200px' }} />
        {showCost && (
          <label className="muted" style={{ display: 'inline-flex', gap: 8, alignItems: 'center', fontSize: 14 }}>
            {t('costBasis')}
            <select className="select" style={{ width: 'auto' }} value={basis} onChange={(e) => setBasis(e.target.value as CostBasis)}>
              <option value="supplier">{t('basisSupplier')}</option>
              <option value="average">{t('basisAverage')}</option>
            </select>
          </label>
        )}
      </div>

      {rows && rows.length === 0 ? (
        <div className="card">
          <Empty title={t('noRecipes')} body={t('noRecipesBody')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('name')}</th>
                {showCost && <th className="end">{t('costPerPortion')}</th>}
                {kind === 'menu' && <th className="end hide-phone">{t('sellingPrice')}</th>}
                {kind === 'menu' && showCost && <th className="end">{t('foodCost')}</th>}
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/recipes/${r.id}`} style={{ fontWeight: 600 }}>
                      {pick(r)}
                    </Link>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {[r.category, r.kind === 'prep' ? `${t('makes')} ${Number(r.yieldQty)} ${t(`u_${r.yieldUnit}` as TKey)}` : null, r.posProduct ? `Foodics: ${pick(r.posProduct)}` : null].filter(Boolean).join(' · ')}
                    </div>
                    {(r.missing.length > 0 || r.cycle) && (
                      <div className="cell-flag" style={{ fontSize: 12 }}>
                        {t('missingCosts')}: {r.missing.join(', ')}
                      </div>
                    )}
                  </td>
                  {showCost && (
                    <td className="end num">
                      {r.unitCost ? fmtMoney(r.unitCost) : '–'}
                      {r.kind === 'prep' && r.unitCost && (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {t('per')} {t(`u_${r.yieldUnit}` as TKey)}
                        </div>
                      )}
                    </td>
                  )}
                  {kind === 'menu' && (
                    <td className="end num hide-phone">
                      {r.price ? fmtMoney(r.price) : '–'}
                      {r.priceSource === 'pos' && (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {t('priceFromPos')}
                        </div>
                      )}
                    </td>
                  )}
                  {kind === 'menu' && showCost && (
                    <td className="end num">
                      {r.foodCostPct ? <span className={`tag ${r.overTarget ? 'tag-late' : 'tag-accent'}`}>{r.foodCostPct}%</span> : '–'}
                      {r.targetCostPct && (
                        <div className="faint" style={{ fontSize: 12 }}>
                          {t('target')} {Number(r.targetCostPct)}%
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {importing && posProducts && (
        <FromFoodics
          products={posProducts}
          onClose={() => setImporting(false)}
          onDone={(created, skipped) => {
            setImporting(false);
            setToast(`${created} ${t('createdN')}${skipped ? ` · ${skipped} ${t('skippedN')}` : ''}`);
            reload();
            reloadPos();
          }}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function FromFoodics({ products, onClose, onDone }: { products: PosProductOption[]; onClose: () => void; onDone: (created: number, skipped: number) => void }) {
  const { t, pick, fmtMoney } = useI18n();
  const { api } = useSession();
  const usable = products.filter((p) => p.hasPosRecipe);
  const [picked, setPicked] = useState<Set<string>>(new Set(usable.map((p) => p.id)));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ created: { name: string }[]; skipped: { name: string; reason: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      title={t('fromFoodics')}
      onClose={() => (result ? onDone(result.created.length, result.skipped.length) : onClose())}
      actions={
        result ? (
          <button className="btn btn-primary" onClick={() => onDone(result.created.length, result.skipped.length)}>
            {t('done')}
          </button>
        ) : (
          <>
            <button className="btn btn-quiet" onClick={onClose}>
              {t('cancel')}
            </button>
            <button
              className="btn btn-primary"
              disabled={busy || picked.size === 0}
              onClick={async () => {
                setBusy(true);
                try {
                  setResult(await api('/recipes/from-pos', { method: 'POST', body: { productIds: [...picked] } }));
                } catch (e) {
                  setError((e as ApiError).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              {t('createRecipes')} <span className="num">({picked.size})</span>
            </button>
          </>
        )
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      {result ? (
        <div style={{ display: 'grid', gap: 10 }}>
          <div>
            <strong className="num">{result.created.length}</strong> {t('createdN')}
          </div>
          {result.skipped.map((s) => (
            <div key={s.name} className="notice" style={{ fontSize: 13 }}>
              <strong>{s.name}</strong> · {s.reason}
            </div>
          ))}
        </div>
      ) : (
        <>
          <div className="faint" style={{ fontSize: 13 }}>
            {t('fromFoodicsBody')}
          </div>
          <div className="pick-list">
            {products.map((p) => (
              <label key={p.id} className="check" style={{ opacity: p.hasPosRecipe ? 1 : 0.55 }}>
                <input
                  type="checkbox"
                  disabled={!p.hasPosRecipe}
                  checked={picked.has(p.id)}
                  onChange={(e) => {
                    const next = new Set(picked);
                    if (e.target.checked) next.add(p.id);
                    else next.delete(p.id);
                    setPicked(next);
                  }}
                />
                <span>
                  {pick(p)} {p.price && <span className="faint num">· {fmtMoney(p.price)}</span>}
                  {!p.hasPosRecipe && <span className="faint"> · {t('noFoodicsRecipe')}</span>}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
    </Dialog>
  );
}
