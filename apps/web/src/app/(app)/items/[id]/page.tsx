'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArmButton, Dialog, Field, PageHead, Toast } from '@/components/ui';
import { IconPlus, IconStar } from '@/components/icons';
import { ALLERGENS, ALL_UNITS, CATEGORIES, IngredientPicker, MatchTag, UNITS_BY_BASE, candidateName } from '@/components/catalog';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { ItemDetail, Pack, Site } from '@/lib/types';

export default function ItemPage() {
  const { id } = useParams<{ id: string }>();
  const { t, pick, lang, fmtMoney, fmtUnitCost, fmtQty, fmtDate } = useI18n();
  const { api, can, me } = useSession();
  const { data: item, error, reload } = useApi<ItemDetail>(`/items/${id}`, [id]);
  const { data: sites } = useApi<Site[]>(can('site:read') ? '/sites' : null);
  const [picking, setPicking] = useState(false);
  const [editingPack, setEditingPack] = useState<Pack | 'new' | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [form, setForm] = useState<{ name: string; nameAr: string; category: string; allergens: string[] } | null>(null);
  const canManage = can('item:manage');
  const showPrices = can('price:read');

  useEffect(() => {
    if (item) setForm({ name: item.name, nameAr: item.nameAr ?? '', category: item.category, allergens: item.allergens });
  }, [item]);

  if (error) return <div className="notice notice-error">{error.message}</div>;
  if (!item || !form) return <div className="muted">{t('loading')}</div>;

  const packLabel = (p: Pack) => (lang === 'ar' && p.nameAr ? p.nameAr : p.name);
  const packById = new Map(item.packs.map((p) => [p.id, p]));
  const dirty = form.name !== item.name || form.nameAr !== (item.nameAr ?? '') || form.category !== item.category || form.allergens.join() !== item.allergens.join();
  const canPar = (siteId: string) =>
    !!me?.memberships.some(
      (m) => m.permissions.some((p) => p === '*' || p === 'par:manage' || p === 'par:*') && (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(siteId)),
    );

  return (
    <div className="page">
      <PageHead
        title={pick(item)}
        sub={`${item.code} · ${t(`cat_${item.category}` as TKey)} · ${t('baseUnit')}: ${t(`u_${item.baseUnit}` as TKey)}`}
        action={
          canManage && (
            <button
              className="btn btn-quiet"
              onClick={async () => {
                await api(`/items/${id}`, { method: 'PATCH', body: { isActive: !item.isActive } });
                reload();
              }}
            >
              <span className={`tag ${item.isActive ? 'tag-accent' : ''}`}>
                <span className="dot" />
                {item.isActive ? t('active') : t('inactive')}
              </span>
            </button>
          )
        }
      />

      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        {/* Details */}
        <section className="card">
          <h2 className="card-title">{t('details')}</h2>
          <div className="form-row">
            <Field label={t('name')}>
              <input className="input" value={form.name} disabled={!canManage} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label={t('nameAr')}>
              <input className="input" value={form.nameAr} disabled={!canManage} onChange={(e) => setForm({ ...form, nameAr: e.target.value })} dir="rtl" lang="ar" />
            </Field>
          </div>
          <Field label={t('category')}>
            <select className="select" value={form.category} disabled={!canManage} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {t(`cat_${c}` as TKey)}
                </option>
              ))}
            </select>
          </Field>
          <div className="field">
            <span>{t('allergens')}</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {ALLERGENS.map((a) => (
                <button
                  key={a}
                  type="button"
                  className="chip"
                  disabled={!canManage}
                  aria-pressed={form.allergens.includes(a)}
                  onClick={() => setForm({ ...form, allergens: form.allergens.includes(a) ? form.allergens.filter((x) => x !== a) : [...form.allergens, a] })}
                >
                  {t(`al_${a}` as TKey)}
                </button>
              ))}
            </div>
          </div>
          {canManage && dirty && (
            <div>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await api(`/items/${id}`, { method: 'PATCH', body: { ...form, nameAr: form.nameAr || null } });
                  setToast(t('saved'));
                  reload();
                }}
              >
                {t('save')}
              </button>
            </div>
          )}
        </section>

        {/* Ingredient match */}
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('ingredientMatch')}</h2>
            {canManage && (
              <button className="btn btn-sm btn-quiet" onClick={() => setPicking(true)}>
                {t('changeMatch')}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <MatchTag source={item.canonicalSource} label={item.canonical ? candidateName(item.canonical, lang) : null} />
            {item.canonical && (
              <span className="faint" style={{ fontSize: 13 }}>
                {item.canonicalSource === 'auto' ? t('matchAuto') : t('matchHuman')}
                {item.canonicalScore ? ` · ${Math.round(Number(item.canonicalScore) * 100)}%` : ''}
              </span>
            )}
          </div>
          <p className="muted" style={{ margin: 0, fontSize: 13 }}>
            {t('ingredientHint')}
          </p>

          <div className="card-head" style={{ marginTop: 8 }}>
            <h2 className="card-title">{t('packs')}</h2>
            {canManage && (
              <button className="btn btn-sm btn-primary" onClick={() => setEditingPack('new')}>
                <IconPlus /> {t('addPack')}
              </button>
            )}
          </div>
          <div style={{ display: 'grid', gap: 8 }}>
            {item.packs.map((p) => (
              <div key={p.id} className="row-line">
                <div className="grow">
                  <div style={{ fontWeight: 500 }}>{packLabel(p)}</div>
                  <div className="faint num" style={{ fontSize: 12 }}>
                    {p.parentPackId ? `${Number(p.qty)} × ${packLabel(packById.get(p.parentPackId)!)} · ` : ''}= {fmtQty(p.baseQty, item.baseUnit)}
                  </div>
                </div>
                {canManage && (
                  <>
                    <button className="btn btn-sm btn-quiet" onClick={() => setEditingPack(p)}>
                      {t('edit')}
                    </button>
                    <ArmButton
                      label={t('remove')}
                      onConfirm={async () => {
                        try {
                          await api(`/items/${id}/packs/${p.id}`, { method: 'DELETE' });
                        } catch (e) {
                          setToast((e as ApiError).message);
                        }
                        reload();
                      }}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Supplier prices */}
        <section className="card">
          <h2 className="card-title">{t('supplierPrices')}</h2>
          {item.supplierItems.length === 0 ? (
            <p className="muted" style={{ margin: 0 }}>
              {t('noSupplierPrices')}
            </p>
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {item.supplierItems.map((s) => (
                <Link key={s.id} href={`/suppliers/${s.relationshipId}`} className="row-line" style={{ color: 'inherit' }}>
                  {s.isPreferred && <IconStar filled width={18} height={18} style={{ color: '#d97706', flex: 'none' }} aria-label={t('preferred')} />}
                  <div className="grow">
                    <div style={{ fontWeight: 500 }}>{pick({ name: s.supplierName, nameAr: s.supplierNameAr })}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {packById.get(s.packId) ? packLabel(packById.get(s.packId)!) : ''} · {t('updated')} {fmtDate(s.priceUpdatedAt)}
                    </div>
                  </div>
                  {showPrices && (
                    <div style={{ textAlign: 'end' }}>
                      <div className="num" style={{ fontWeight: 600 }}>
                        {fmtMoney(s.currentPrice)}
                      </div>
                      <div className="faint num" style={{ fontSize: 12 }}>
                        {fmtUnitCost(s.costPerBase, item.baseUnit)}
                      </div>
                    </div>
                  )}
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Par levels */}
        {sites && sites.length > 0 && (
          <section className="card">
            <h2 className="card-title">{t('parLevels')}</h2>
            <p className="muted" style={{ margin: 0, fontSize: 13 }}>
              {t('parLevelsHint')}
            </p>
            {sites.map((s) => (
              <ParRow
                key={s.id}
                siteName={pick(s)}
                item={item}
                setting={item.siteSettings.find((x) => x.siteId === s.id)}
                editable={canPar(s.id)}
                onSave={async (body) => {
                  await api(`/items/${id}/sites/${s.id}`, { method: 'PUT', body });
                  setToast(t('saved'));
                  reload();
                }}
              />
            ))}
          </section>
        )}
      </div>

      {picking && (
        <IngredientPicker
          initial={item.name}
          onClose={() => setPicking(false)}
          onPick={async (c) => {
            await api(`/items/${id}/canonical`, { method: 'PUT', body: { canonicalId: c?.canonicalId ?? null } });
            setPicking(false);
            reload();
          }}
        />
      )}
      {editingPack && (
        <PackDialog
          item={item}
          pack={editingPack === 'new' ? null : editingPack}
          onClose={() => setEditingPack(null)}
          onSaved={() => {
            setEditingPack(null);
            reload();
          }}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function ParRow({
  siteName,
  item,
  setting,
  editable,
  onSave,
}: {
  siteName: string;
  item: ItemDetail;
  setting?: { parLevel: string | null; reorderPoint: string | null };
  editable: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { t, lang } = useI18n();
  const defaultPack = item.packs.find((p) => p.isCountable) ?? item.packs[0];
  const [packId, setPackId] = useState(defaultPack?.id ?? '');
  const factor = Number(item.packs.find((p) => p.id === packId)?.baseQty ?? 1);
  const toPack = (v: string | null | undefined) => (v === null || v === undefined ? '' : String(Math.round((Number(v) / factor) * 1000) / 1000));
  const [par, setPar] = useState(toPack(setting?.parLevel));
  const [reorder, setReorder] = useState(toPack(setting?.reorderPoint));
  useEffect(() => {
    setPar(toPack(setting?.parLevel));
    setReorder(toPack(setting?.reorderPoint));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [packId, setting?.parLevel, setting?.reorderPoint]);
  const changed = par !== toPack(setting?.parLevel) || reorder !== toPack(setting?.reorderPoint);

  return (
    <div className="row-line" style={{ flexWrap: 'wrap' }}>
      <div className="grow" style={{ fontWeight: 500, minWidth: 120 }}>
        {siteName}
      </div>
      <label className="field" style={{ gap: 2 }}>
        <span style={{ fontSize: 12 }}>{t('par')}</span>
        <input className="input inline-input num" inputMode="decimal" value={par} disabled={!editable} onChange={(e) => setPar(e.target.value)} />
      </label>
      <label className="field" style={{ gap: 2 }}>
        <span style={{ fontSize: 12 }}>{t('reorderAt')}</span>
        <input className="input inline-input num" inputMode="decimal" value={reorder} disabled={!editable} onChange={(e) => setReorder(e.target.value)} />
      </label>
      <label className="field" style={{ gap: 2 }}>
        <span style={{ fontSize: 12 }}>{t('in')}</span>
        <select className="select" style={{ minHeight: 44, width: 'auto' }} value={packId} onChange={(e) => setPackId(e.target.value)}>
          {item.packs.map((p) => (
            <option key={p.id} value={p.id}>
              {lang === 'ar' && p.nameAr ? p.nameAr : p.name}
            </option>
          ))}
        </select>
      </label>
      {editable && changed && (
        <button
          className="btn btn-sm btn-primary"
          style={{ alignSelf: 'flex-end' }}
          onClick={() => onSave({ parLevel: par === '' ? null : Number(par), reorderPoint: reorder === '' ? null : Number(reorder), packId })}
        >
          {t('save')}
        </button>
      )}
    </div>
  );
}

function PackDialog({ item, pack, onClose, onSaved }: { item: ItemDetail; pack: Pack | null; onClose: () => void; onSaved: () => void }) {
  const { t, lang } = useI18n();
  const { api } = useSession();
  const [f, setF] = useState({
    name: pack?.name ?? '',
    nameAr: pack?.nameAr ?? '',
    qty: pack ? String(Number(pack.qty)) : '',
    mode: pack?.parentPackId ? 'pack' : 'unit',
    unit: pack?.unit ?? UNITS_BY_BASE[item.baseUnit]![0]!,
    parentPackId: pack?.parentPackId ?? item.packs.find((p) => p.id !== pack?.id)?.id ?? '',
    barcode: pack?.barcode ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const others = item.packs.filter((p) => p.id !== pack?.id);
  const hasConversion = item.conversions.length > 0;
  const units = hasConversion ? ALL_UNITS : UNITS_BY_BASE[item.baseUnit]!;

  return (
    <Dialog
      title={pack ? t('edit') : t('addPack')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!f.name || !Number(f.qty)}
            onClick={async () => {
              setError(null);
              const body = {
                name: f.name,
                nameAr: f.nameAr || null,
                qty: Number(f.qty),
                barcode: f.barcode || null,
                ...(f.mode === 'unit' ? { unit: f.unit, parentPackId: null } : { parentPackId: f.parentPackId, unit: null }),
              };
              try {
                if (pack) await api(`/items/${item.id}/packs/${pack.id}`, { method: 'PATCH', body });
                else await api(`/items/${item.id}/packs`, { method: 'POST', body });
                onSaved();
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
        <Field label={t('packName')}>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Case 6×1L" />
        </Field>
        <Field label={t('packNameAr')}>
          <input className="input" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} dir="rtl" lang="ar" />
        </Field>
      </div>
      <div className="segmented" role="group">
        <button type="button" aria-pressed={f.mode === 'unit'} onClick={() => setF({ ...f, mode: 'unit' })}>
          {t('unit')}
        </button>
        <button type="button" aria-pressed={f.mode === 'pack'} disabled={others.length === 0} onClick={() => setF({ ...f, mode: 'pack' })}>
          {t('ofPack')}
        </button>
      </div>
      <div className="form-row">
        <Field label={t('contains')}>
          <input className="input num" inputMode="decimal" value={f.qty} onChange={(e) => setF({ ...f, qty: e.target.value })} />
        </Field>
        {f.mode === 'unit' ? (
          <Field label={t('unit')}>
            <select className="select" value={f.unit} onChange={(e) => setF({ ...f, unit: e.target.value })}>
              {units.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </Field>
        ) : (
          <Field label={t('pack')}>
            <select className="select" value={f.parentPackId} onChange={(e) => setF({ ...f, parentPackId: e.target.value })}>
              {others.map((p) => (
                <option key={p.id} value={p.id}>
                  {lang === 'ar' && p.nameAr ? p.nameAr : p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
      </div>
      <Field label={t('barcode')} hint={t('optional')}>
        <input className="input num" value={f.barcode} onChange={(e) => setF({ ...f, barcode: e.target.value })} dir="ltr" inputMode="numeric" />
      </Field>
    </Dialog>
  );
}
