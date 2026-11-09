'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArmButton, Field, PageHead, Toast } from '@/components/ui';
import { IconPlus, IconX } from '@/components/icons';
import { readNumber } from '@/components/stock';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { StockItem } from '@/lib/types-stock';
import type { PosProductOption, RecipeDetail, RecipeRow } from '@/lib/types-recipes';

const DIM: Record<string, string[]> = { g: ['g', 'kg'], ml: ['ml', 'l'], each: ['each', 'dozen'] };
const ALL_UNITS = ['g', 'kg', 'ml', 'l', 'each', 'dozen'];
const baseOf = (u: string) => (DIM.g!.includes(u) ? 'g' : DIM.ml!.includes(u) ? 'ml' : 'each');

interface DraftLine {
  key: string;
  ref: string; // "item:<id>" or "prep:<id>"
  qty: string;
  unit: string; // "unit:g" or "pack:<id>"
  yieldPct: string;
}
interface Draft {
  name: string;
  nameAr: string;
  kind: 'menu' | 'prep';
  category: string;
  yieldQty: string;
  yieldUnit: string;
  sellingPrice: string;
  priceIncludesVat: boolean;
  targetCostPct: string;
  posProductId: string;
  notes: string;
  lines: DraftLine[];
}

let seq = 0;
const key = () => `l${Date.now()}${seq++}`;

function fromDetail(r: RecipeDetail): Draft {
  return {
    name: r.name,
    nameAr: r.nameAr ?? '',
    kind: r.kind,
    category: r.category ?? '',
    yieldQty: String(Number(r.yieldQty)),
    yieldUnit: r.yieldUnit,
    sellingPrice: r.sellingPrice ? String(Number(r.sellingPrice)) : '',
    priceIncludesVat: r.priceIncludesVat,
    targetCostPct: r.targetCostPct ? String(Number(r.targetCostPct)) : '',
    posProductId: r.posProductId ?? '',
    notes: r.notes ?? '',
    lines: r.lines.map((l) => ({
      key: key(),
      ref: l.itemId ? `item:${l.itemId}` : `prep:${l.subRecipeId}`,
      qty: String(Number(l.qty)),
      unit: l.packId ? `pack:${l.packId}` : `unit:${l.unit ?? l.baseUnit ?? 'g'}`,
      yieldPct: String(Number(l.yieldPct)),
    })),
  };
}

/** What the API takes, from the form (lines that aren't complete are left out). */
function toBody(d: Draft) {
  return {
    name: d.name.trim() || '…',
    nameAr: d.nameAr.trim() || null,
    kind: d.kind,
    category: d.category.trim() || null,
    yieldQty: d.kind === 'menu' ? readNumber(d.yieldQty) || 1 : readNumber(d.yieldQty) || 1,
    yieldUnit: d.kind === 'menu' ? 'each' : d.yieldUnit,
    sellingPrice: d.kind === 'menu' && d.sellingPrice.trim() ? readNumber(d.sellingPrice) : null,
    priceIncludesVat: d.priceIncludesVat,
    targetCostPct: d.kind === 'menu' && d.targetCostPct.trim() ? readNumber(d.targetCostPct) : null,
    posProductId: d.kind === 'menu' && d.posProductId ? d.posProductId : null,
    notes: d.notes.trim() || null,
    lines: d.lines
      .filter((l) => l.ref && readNumber(l.qty) > 0)
      .map((l) => {
        const [kind, id] = l.ref.split(':');
        const [uk, uv] = l.unit.split(':');
        return {
          itemId: kind === 'item' ? id : null,
          subRecipeId: kind === 'prep' ? id : null,
          qty: readNumber(l.qty),
          unit: uk === 'unit' ? uv : null,
          packId: uk === 'pack' ? uv : null,
          yieldPct: kind === 'item' ? Math.min(100, Math.max(1, readNumber(l.yieldPct) || 100)) : 100,
        };
      }),
  };
}

export function RecipeEditor({ recipe, initialKind }: { recipe?: RecipeDetail; initialKind?: 'menu' | 'prep' }) {
  const { t, pick, fmtMoney } = useI18n();
  const { api, can } = useSession();
  const router = useRouter();
  const manage = can('recipe:manage');
  const showCost = can('price:read');
  const { data: items } = useApi<StockItem[]>('/stock-items');
  const { data: preps } = useApi<RecipeRow[]>('/recipes?kind=prep');
  const { data: posProducts } = useApi<PosProductOption[]>('/recipes/pos-products');
  const [draft, setDraft] = useState<Draft>(() =>
    recipe
      ? fromDetail(recipe)
      : { name: '', nameAr: '', kind: initialKind ?? 'menu', category: '', yieldQty: '1', yieldUnit: initialKind === 'prep' ? 'kg' : 'each', sellingPrice: '', priceIncludesVat: true, targetCostPct: '30', posProductId: '', notes: '', lines: [{ key: key(), ref: '', qty: '', unit: 'unit:g', yieldPct: '100' }] },
  );
  const [preview, setPreview] = useState<RecipeDetail | null>(recipe ?? null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const body = useMemo(() => toBody(draft), [draft]);
  const bodyKey = JSON.stringify(body);

  // Live cost: preview the draft shortly after each change.
  const last = useRef('');
  useEffect(() => {
    if (!showCost || bodyKey === last.current) return;
    const h = setTimeout(async () => {
      last.current = bodyKey;
      try {
        setPreview(await api<RecipeDetail>('/recipes/preview', { method: 'POST', body: { ...body, recipeId: recipe?.id ?? null } }));
      } catch {
        /* the form shows problems on save */
      }
    }, 400);
    return () => clearTimeout(h);
  }, [bodyKey, body, api, recipe?.id, showCost]);

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }));
  const setLine = (k: string, patch: Partial<DraftLine>) => setDraft((d) => ({ ...d, lines: d.lines.map((l) => (l.key === k ? { ...l, ...patch } : l)) }));
  const linkedPos = recipe?.posProduct ? [{ id: recipe.posProduct.id, name: recipe.posProduct.name, nameAr: recipe.posProduct.nameAr, price: null, category: null, hasPosRecipe: false }] : [];
  const posChoices = [...linkedPos, ...(posProducts ?? [])];
  // Preview lines line up with the complete lines of the form.
  const complete = draft.lines.filter((l) => l.ref && readNumber(l.qty) > 0).map((l) => l.key);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const saved = recipe
        ? await api<RecipeDetail>(`/recipes/${recipe.id}`, { method: 'PATCH', body })
        : await api<RecipeDetail>('/recipes', { method: 'POST', body });
      setToast(t('recipeSaved'));
      if (!recipe) router.replace(`/recipes/${saved.id}`);
      else setPreview(saved);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="page">
      <PageHead
        title={draft.name.trim() || t('newRecipe')}
        sub={t(draft.kind === 'menu' ? 'menuItem' : 'prep')}
        action={
          showCost && preview?.unitCost ? (
            <div className="recipe-cost-chip">
              <span className="num">{fmtMoney(preview.unitCost)}</span>
              <span className="faint">{draft.kind === 'menu' ? t('perPortion') : `${t('per')} ${t(`u_${draft.yieldUnit}` as TKey)}`}</span>
              {preview.foodCostPct && <span className={`tag ${preview.overTarget ? 'tag-late' : 'tag-accent'}`}>{preview.foodCostPct}%</span>}
            </div>
          ) : null
        }
      />
      {error && <div className="notice notice-error">{error}</div>}

      <section className="card" style={{ gap: 14 }}>
        <div className="segmented" role="group" style={{ alignSelf: 'flex-start' }}>
          {(['menu', 'prep'] as const).map((k) => (
            <button key={k} aria-pressed={draft.kind === k} disabled={!manage || (k === 'menu' && (recipe?.usedIn.length ?? 0) > 0)} onClick={() => set({ kind: k, yieldUnit: k === 'menu' ? 'each' : draft.yieldUnit === 'each' ? 'kg' : draft.yieldUnit })}>
              {t(k === 'menu' ? 'menuItem' : 'prep')}
            </button>
          ))}
        </div>
        <div className="form-row">
          <Field label={t('name')}>
            <input className="input" value={draft.name} onChange={(e) => set({ name: e.target.value })} disabled={!manage} />
          </Field>
          <Field label={t('nameArLabel')}>
            <input className="input" dir="rtl" value={draft.nameAr} onChange={(e) => set({ nameAr: e.target.value })} disabled={!manage} />
          </Field>
        </div>
        <div className="form-row">
          <Field label={t('categoryLabel')}>
            <input className="input" value={draft.category} onChange={(e) => set({ category: e.target.value })} disabled={!manage} />
          </Field>
          {draft.kind === 'prep' ? (
            <Field label={t('makes')}>
              <div className="qty-row">
                <input className="input num" inputMode="decimal" value={draft.yieldQty} onChange={(e) => set({ yieldQty: e.target.value })} disabled={!manage} />
                <select className="select" value={draft.yieldUnit} onChange={(e) => set({ yieldUnit: e.target.value })} disabled={!manage}>
                  {ALL_UNITS.map((u) => (
                    <option key={u} value={u}>
                      {t(`u_${u}` as TKey)}
                    </option>
                  ))}
                </select>
              </div>
            </Field>
          ) : (
            <Field label={t('posProduct')}>
              <select className="select" value={draft.posProductId} onChange={(e) => set({ posProductId: e.target.value })} disabled={!manage}>
                <option value="">{t('noPosProduct')}</option>
                {posChoices.map((p) => (
                  <option key={p.id} value={p.id}>
                    {pick(p)}
                  </option>
                ))}
              </select>
            </Field>
          )}
        </div>
        {draft.kind === 'menu' && (
          <div className="form-row">
            <Field label={t('sellingPrice')} hint={preview?.priceSource === 'pos' && !draft.sellingPrice ? `${t('priceFromPos')}: ${fmtMoney(preview.price ?? 0)}` : undefined}>
              <input className="input num" inputMode="decimal" value={draft.sellingPrice} placeholder={preview?.priceSource === 'pos' ? String(Number(preview.price)) : ''} onChange={(e) => set({ sellingPrice: e.target.value })} disabled={!manage} />
              <label className="check" style={{ marginTop: 6 }}>
                <input type="checkbox" checked={draft.priceIncludesVat} onChange={(e) => set({ priceIncludesVat: e.target.checked })} disabled={!manage} />
                {t('priceIncludesVat')}
              </label>
            </Field>
            <Field label={`${t('target')} (${t('foodCost')} %)`}>
              <input className="input num" inputMode="decimal" value={draft.targetCostPct} onChange={(e) => set({ targetCostPct: e.target.value })} disabled={!manage} />
            </Field>
          </div>
        )}
      </section>

      <section className="card" style={{ gap: 10 }}>
        <div className="card-title" style={{ fontSize: 15 }}>
          {t('ingredients')}
        </div>
        <div className="recipe-lines">
          <div className="recipe-line recipe-line-head hide-phone" aria-hidden>
            <span>{t('chooseIngredient')}</span>
            <span>{t('qty')}</span>
            <span>{t('in')}</span>
            <span title={t('usableHint')}>{t('usable')}</span>
            <span className="recipe-line-cost">{showCost ? t('lineCost') : ''}</span>
            <span />
          </div>
          {draft.lines.map((l) => {
            const pv = preview && complete.includes(l.key) ? preview.lines[complete.indexOf(l.key)] : undefined;
            return (
              <LineRow
                key={l.key}
                line={l}
                items={items ?? []}
                preps={(preps ?? []).filter((p) => p.id !== recipe?.id)}
                preview={pv}
                manage={manage}
                showCost={showCost}
                onChange={(patch) => setLine(l.key, patch)}
                onRemove={() => setDraft((d) => ({ ...d, lines: d.lines.filter((x) => x.key !== l.key) }))}
              />
            );
          })}
        </div>
        {manage && (
          <button className="btn btn-quiet" style={{ justifySelf: 'start' }} onClick={() => setDraft((d) => ({ ...d, lines: [...d.lines, { key: key(), ref: '', qty: '', unit: 'unit:g', yieldPct: '100' }] }))}>
            <IconPlus /> {t('addIngredient')}
          </button>
        )}
        {showCost && preview && (
          <div className="recipe-totals">
            <div>
              <span className="muted">{t('total')}</span> <strong className="num">{fmtMoney(preview.batchCost ?? 0)}</strong>
              {draft.kind === 'prep' && preview.unitCost && (
                <span className="faint num">
                  {' '}
                  · {fmtMoney(preview.unitCost)} {t('per')} {t(`u_${draft.yieldUnit}` as TKey)}
                </span>
              )}
            </div>
            {draft.kind === 'menu' && preview.priceExVat && (
              <div className="faint num" style={{ fontSize: 13 }}>
                {t('priceBeforeVat')} {fmtMoney(preview.priceExVat)} · {t('foodCost')} {preview.foodCostPct ?? '–'}%
              </div>
            )}
            {preview.missing.length > 0 && (
              <div className="cell-flag" style={{ fontSize: 13 }}>
                {t('missingCosts')}: {preview.missing.join(', ')}
              </div>
            )}
          </div>
        )}
        {showCost && (
          <div className="faint" style={{ fontSize: 12 }}>
            {t('liveCost')}
          </div>
        )}
      </section>

      {(preview?.allergens.length || recipe?.usedIn.length) ? (
        <section className="card" style={{ gap: 8 }}>
          {preview && preview.allergens.length > 0 && (
            <div>
              <span className="muted">{t('allergens')}: </span>
              {preview.allergens.map((a) => (
                <span key={a} className="tag" style={{ marginInlineEnd: 6 }}>
                  {t(`al_${a}` as TKey)}
                </span>
              ))}
            </div>
          )}
          {recipe && recipe.usedIn.length > 0 && (
            <div>
              <span className="muted">{t('usedIn')}: </span>
              {recipe.usedIn.map((u, i) => (
                <span key={u.id}>
                  {i > 0 && ', '}
                  <Link href={`/recipes/${u.id}`}>{pick(u)}</Link>
                </span>
              ))}
            </div>
          )}
        </section>
      ) : null}

      <section className="card" style={{ gap: 8 }}>
        <Field label={t('notesLabel')}>
          <textarea className="input" rows={3} value={draft.notes} onChange={(e) => set({ notes: e.target.value })} disabled={!manage} />
        </Field>
      </section>

      {manage && (
        <div className="count-bar">
          <Link href="/recipes" className="link-btn">
            ← {t('recipes')}
          </Link>
          <div style={{ display: 'flex', gap: 8 }}>
            {recipe && (
              <ArmButton
                label={t('deleteRecipe')}
                small={false}
                onConfirm={async () => {
                  try {
                    await api(`/recipes/${recipe.id}`, { method: 'DELETE' });
                    router.replace('/recipes');
                  } catch (e) {
                    setError((e as ApiError).message);
                  }
                }}
              />
            )}
            <button className="btn btn-primary" disabled={saving || !draft.name.trim()} onClick={save}>
              {t('saveRecipe')}
            </button>
          </div>
        </div>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function LineRow({
  line,
  items,
  preps,
  preview,
  manage,
  showCost,
  onChange,
  onRemove,
}: {
  line: DraftLine;
  items: StockItem[];
  preps: RecipeRow[];
  preview?: RecipeDetail['lines'][number];
  manage: boolean;
  showCost: boolean;
  onChange: (patch: Partial<DraftLine>) => void;
  onRemove: () => void;
}) {
  const { t, pick, fmtMoney, fmtQty, lang } = useI18n();
  const [kind, id] = line.ref.split(':');
  const item = kind === 'item' ? items.find((i) => i.id === id) : undefined;
  const prep = kind === 'prep' ? preps.find((p) => p.id === id) : undefined;
  const base = item?.baseUnit ?? (prep ? baseOf(prep.yieldUnit) : 'g');
  const same = DIM[base] ?? ['g'];
  const other = ALL_UNITS.filter((u) => !same.includes(u));
  // Pick a sensible unit when the ingredient changes.
  useEffect(() => {
    if (!line.ref) return;
    const [uk, uv] = line.unit.split(':');
    const ok = uk === 'pack' ? !!item?.packs.some((p) => p.id === uv) : ALL_UNITS.includes(uv!);
    if (!ok || (uk === 'unit' && !same.includes(uv!) && !other.includes(uv!))) onChange({ unit: `unit:${base}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [line.ref]);
  return (
    <div className={`recipe-line${preview?.problem ? ' has-problem' : ''}`}>
      <select className="select recipe-line-ref" value={line.ref} onChange={(e) => onChange({ ref: e.target.value, unit: 'unit:' })} disabled={!manage} aria-label={t('chooseIngredient')}>
        <option value="">{t('chooseIngredient')}</option>
        <optgroup label={t('itemsGroup')}>
          {items.map((i) => (
            <option key={i.id} value={`item:${i.id}`}>
              {pick(i)}
            </option>
          ))}
        </optgroup>
        {preps.length > 0 && (
          <optgroup label={t('prepsGroup')}>
            {preps.map((p) => (
              <option key={p.id} value={`prep:${p.id}`}>
                {pick(p)}
              </option>
            ))}
          </optgroup>
        )}
      </select>
      <input className="input num" inputMode="decimal" placeholder={t('qty')} value={line.qty} onChange={(e) => onChange({ qty: e.target.value })} disabled={!manage || !line.ref} aria-label={t('qty')} />
      <select className="select" value={line.unit} onChange={(e) => onChange({ unit: e.target.value })} disabled={!manage || !line.ref} aria-label={t('in')}>
        {same.map((u) => (
          <option key={u} value={`unit:${u}`}>
            {t(`u_${u}` as TKey)}
          </option>
        ))}
        {item?.packs.map((p) => (
          <option key={p.id} value={`pack:${p.id}`}>
            {lang === 'ar' && p.nameAr ? p.nameAr : p.name}
          </option>
        ))}
        <optgroup label={t('otherUnits')}>
          {other.map((u) => (
            <option key={u} value={`unit:${u}`}>
              {t(`u_${u}` as TKey)}
            </option>
          ))}
        </optgroup>
      </select>
      {kind === 'item' ? (
        <input className="input num" inputMode="decimal" title={t('usableHint')} value={line.yieldPct} onChange={(e) => onChange({ yieldPct: e.target.value })} disabled={!manage} aria-label={t('usable')} />
      ) : (
        <span />
      )}
      <div className="recipe-line-cost num">
        {preview?.problem ? (
          <span className="cell-flag" style={{ fontSize: 12 }}>
            {t(`problem_${preview.problem}` as TKey)}
          </span>
        ) : showCost && preview?.cost ? (
          <>
            {fmtMoney(preview.cost)}
            {preview.grossBase && preview.baseUnit && preview.grossBase !== preview.qtyBase && (
              <div className="faint" style={{ fontSize: 11 }}>
                {fmtQty(preview.grossBase, preview.baseUnit)}
              </div>
            )}
          </>
        ) : null}
      </div>
      {manage ? (
        <button className="icon-btn" onClick={onRemove} aria-label={t('cancel')}>
          <IconX />
        </button>
      ) : (
        <span />
      )}
    </div>
  );
}
