'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Dialog, Field, PageHead, Toast } from '@/components/ui';
import { IconDownload, IconPlus, IconSearch, IconStar, IconUpload } from '@/components/icons';
import { ChangeTag, ImportDialog, downloadCsv, useDebounced } from '@/components/catalog';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { ItemDetail, ItemRow, PriceHistoryRow, Site, SupplierDetail, SupplierLine } from '@/lib/types';

export default function SupplierPage() {
  const { id } = useParams<{ id: string }>();
  const { t, pick, lang, fmtMoney, fmtUnitCost, fmtDate } = useI18n();
  const { api, can } = useSession();
  const { data: s, error, reload } = useApi<SupplierDetail>(`/suppliers/${id}`, [id]);
  const { data: sites } = useApi<Site[]>(can('site:read') ? '/sites' : null);
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [history, setHistory] = useState<SupplierLine | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const canManage = can('supplier:manage');
  const canPrice = can('price:manage');
  const showPrices = can('price:read');

  if (error) return <div className="notice notice-error">{error.message}</div>;
  if (!s) return <div className="muted">{t('loading')}</div>;
  const days = t('days').split(',');

  return (
    <div className="page">
      <PageHead
        title={pick({ name: s.displayName, nameAr: s.displayNameAr })}
        sub={`${t(`ch_${s.orderChannel}` as TKey)}${s.profile?.vatNumber ? ` · ${t('vatNumber')} ${s.profile.vatNumber}` : ''}`}
        action={
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {showPrices && (
              <button className="btn btn-quiet" onClick={() => downloadCsv(api, `/suppliers/${id}/prices/export`, 'price-list.csv')}>
                <IconDownload /> {t('priceListExport')}
              </button>
            )}
            {canPrice && (
              <button className="btn btn-quiet" onClick={() => setImporting(true)}>
                <IconUpload /> {t('priceListImport')}
              </button>
            )}
          </div>
        }
      />

      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))' }}>
        <section className="card">
          <h2 className="card-title">{t('details')}</h2>
          <dl className="dl">
            <dt>{t('contactName')}</dt>
            <dd>{s.contactName || '–'}</dd>
            <dt>{t('contactEmail')}</dt>
            <dd dir="ltr">{s.contactEmail || '–'}</dd>
            <dt>{t('contactPhone')}</dt>
            <dd dir="ltr">{s.contactPhone || '–'}</dd>
            <dt>{t('paymentTerms')}</dt>
            <dd className="num">{s.paymentTermsDays}</dd>
            <dt>{t('vatRate')}</dt>
            <dd className="num">{Math.round(Number(s.taxRate) * 100)}%</dd>
            <dt>{t('minOrder')}</dt>
            <dd className="num">{s.minOrderValue ? fmtMoney(s.minOrderValue) : '–'}</dd>
          </dl>
          <div>{s.profile?.isClaimed ? <span className="tag tag-accent">{t('claimed')}</span> : <span className="tag">{t('unclaimed')}</span>}</div>
        </section>

        {sites && sites.length > 0 && (
          <section className="card">
            <h2 className="card-title">{t('deliverySchedule')}</h2>
            {sites.map((site) => (
              <ScheduleRow
                key={site.id}
                siteName={pick(site)}
                days={days}
                value={s.schedule.find((x) => x.siteId === site.id)}
                editable={canManage}
                onSave={async (body) => {
                  await api(`/suppliers/${id}/sites/${site.id}`, { method: 'PUT', body });
                  setToast(t('saved'));
                  reload();
                }}
              />
            ))}
          </section>
        )}
      </div>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('catalogue')}</h2>
          {canPrice && (
            <button className="btn btn-sm btn-primary" onClick={() => setAdding(true)}>
              <IconPlus /> {t('addLine')}
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th />
                <th>{t('name')}</th>
                <th className="hide-phone">{t('pack')}</th>
                {showPrices && <th className="end">{t('price')}</th>}
                {showPrices && <th className="end hide-phone">{t('change')}</th>}
              </tr>
            </thead>
            <tbody>
              {s.items.map((l) => (
                <tr key={l.id} style={{ opacity: l.isActive ? 1 : 0.55 }}>
                  <td style={{ width: 44, paddingInline: 4 }}>
                    <button
                      className="star-btn"
                      aria-pressed={l.isPreferred}
                      aria-label={t('preferred')}
                      title={t('preferred')}
                      disabled={!canPrice}
                      onClick={async () => {
                        await api(`/supplier-items/${l.id}`, { method: 'PATCH', body: { isPreferred: !l.isPreferred } });
                        reload();
                      }}
                    >
                      <IconStar filled={l.isPreferred} width={18} height={18} />
                    </button>
                  </td>
                  <td>
                    <Link href={`/items/${l.itemId}`} style={{ color: 'inherit', fontWeight: 500 }}>
                      {pick({ name: l.itemName, nameAr: l.itemNameAr })}
                    </Link>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {[l.supplierSku, l.supplierName].filter(Boolean).join(' · ') || l.itemCode}
                    </div>
                  </td>
                  <td className="hide-phone">{lang === 'ar' && l.packNameAr ? l.packNameAr : l.packName}</td>
                  {showPrices && (
                    <td className="end">
                      {canPrice ? (
                        <PriceInput
                          value={l.currentPrice!}
                          onSave={async (price) => {
                            await api(`/supplier-items/${l.id}/prices`, { method: 'POST', body: { price } });
                            reload();
                          }}
                        />
                      ) : (
                        <span className="num">{fmtMoney(l.currentPrice)}</span>
                      )}
                      <div className="faint num" style={{ fontSize: 12 }}>
                        {fmtUnitCost(l.costPerBase, l.baseUnit)}
                      </div>
                    </td>
                  )}
                  {showPrices && (
                    <td className="end hide-phone">
                      <button className="btn btn-sm btn-quiet" onClick={() => setHistory(l)} title={t('history')}>
                        {l.changePct !== null && l.changePct !== undefined ? <ChangeTag pct={l.changePct} /> : fmtDate(l.priceUpdatedAt)}
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {adding && (
        <AddLineDialog
          supplierId={id}
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
      {importing && (
        <ImportDialog
          title={t('priceListImport')}
          endpoint={`/suppliers/${id}/prices/import`}
          columnsHint={t('pricesCsvColumns')}
          onClose={() => setImporting(false)}
          onDone={() => {
            setToast(t('imported'));
            reload();
          }}
        />
      )}
      {history && <HistoryDialog line={history} onClose={() => setHistory(null)} />}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function PriceInput({ value, onSave }: { value: string; onSave: (price: number) => Promise<void> }) {
  const { lang } = useI18n();
  const [v, setV] = useState(Number(value).toFixed(2));
  useEffect(() => setV(Number(value).toFixed(2)), [value]);
  const changed = Number(v) !== Number(value) && v !== '' && Number.isFinite(Number(v));
  return (
    <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
      <input
        className="input inline-input num"
        style={{ width: 110, textAlign: 'end' }}
        inputMode="decimal"
        value={v}
        aria-label="price"
        onChange={(e) => setV(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && changed && onSave(Number(v))}
        dir="ltr"
      />
      {changed && (
        <button className="btn btn-sm btn-primary" onClick={() => onSave(Number(v))}>
          {lang === 'ar' ? 'حفظ' : 'Save'}
        </button>
      )}
    </span>
  );
}

function ScheduleRow({
  siteName,
  days,
  value,
  editable,
  onSave,
}: {
  siteName: string;
  days: string[];
  value?: { deliveryDays: number[]; cutoffTime: string | null; leadTimeDays: number };
  editable: boolean;
  onSave: (body: Record<string, unknown>) => Promise<void>;
}) {
  const { t } = useI18n();
  const [sel, setSel] = useState<number[]>(value?.deliveryDays ?? []);
  const [cutoff, setCutoff] = useState(value?.cutoffTime ?? '');
  const [lead, setLead] = useState(String(value?.leadTimeDays ?? 1));
  const changed =
    sel.slice().sort().join() !== (value?.deliveryDays ?? []).slice().sort().join() || cutoff !== (value?.cutoffTime ?? '') || lead !== String(value?.leadTimeDays ?? 1);
  return (
    <div style={{ display: 'grid', gap: 8, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
      <strong style={{ fontWeight: 500 }}>{siteName}</strong>
      <div className="day-chips" role="group" aria-label={t('deliveryDays')}>
        {days.map((d, i) => (
          <button
            key={i}
            type="button"
            className="chip"
            disabled={!editable}
            aria-pressed={sel.includes(i)}
            onClick={() => setSel(sel.includes(i) ? sel.filter((x) => x !== i) : [...sel, i])}
          >
            {d}
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <label className="field" style={{ gap: 2 }}>
          <span style={{ fontSize: 12 }}>{t('cutoff')}</span>
          <input className="input inline-input num" type="time" value={cutoff} disabled={!editable} onChange={(e) => setCutoff(e.target.value)} dir="ltr" />
        </label>
        <label className="field" style={{ gap: 2 }}>
          <span style={{ fontSize: 12 }}>{t('leadTime')}</span>
          <input className="input inline-input num" inputMode="numeric" value={lead} disabled={!editable} onChange={(e) => setLead(e.target.value)} />
        </label>
        {editable && changed && (
          <button className="btn btn-sm btn-primary" onClick={() => onSave({ deliveryDays: sel, cutoffTime: cutoff || null, leadTimeDays: Number(lead || 0) })}>
            {t('save')}
          </button>
        )}
      </div>
    </div>
  );
}

function AddLineDialog({ supplierId, onClose, onSaved }: { supplierId: string; onClose: () => void; onSaved: () => void }) {
  const { t, pick, lang, fmtQty } = useI18n();
  const { api } = useSession();
  const [q, setQ] = useState('');
  const dq = useDebounced(q);
  const { data: results } = useApi<ItemRow[]>(`/items?limit=20${dq ? `&q=${encodeURIComponent(dq)}` : ''}`, [dq]);
  const [item, setItem] = useState<ItemDetail | null>(null);
  const [packId, setPackId] = useState('');
  const [sku, setSku] = useState('');
  const [supName, setSupName] = useState('');
  const [price, setPrice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pickItem = async (id: string) => {
    const d = await api<ItemDetail>(`/items/${id}`);
    setItem(d);
    setPackId(d.packs.find((p) => p.isOrderable)?.id ?? d.packs[0]?.id ?? '');
  };

  return (
    <Dialog
      title={t('addLine')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!item || !packId || price === '' || !Number.isFinite(Number(price))}
            onClick={async () => {
              setError(null);
              try {
                await api(`/suppliers/${supplierId}/items`, {
                  method: 'POST',
                  body: { itemId: item!.id, packId, supplierSku: sku || null, supplierName: supName || null, price: Number(price) },
                });
                onSaved();
              } catch (e) {
                const err = e as ApiError;
                setError(err.status === 409 ? `${t('supplierSku')} / ${t('pack')}: ${err.message}` : err.message);
              }
            }}
          >
            {t('save')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      {!item ? (
        <>
          <div style={{ position: 'relative' }}>
            <IconSearch style={{ position: 'absolute', insetInlineStart: 14, top: 14, color: 'var(--t3)' }} />
            <input className="input" style={{ paddingInlineStart: 44 }} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('searchItems')} autoFocus />
          </div>
          <div style={{ display: 'grid', gap: 6, maxHeight: 320, overflowY: 'auto' }}>
            {results?.map((r) => (
              <button key={r.id} className="btn btn-quiet" style={{ justifyContent: 'space-between' }} onClick={() => pickItem(r.id)}>
                <span>{pick(r)}</span>
                <span className="faint num">{r.code}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="row-line">
            <div className="grow" style={{ fontWeight: 500 }}>
              {pick(item)} <span className="faint num">{item.code}</span>
            </div>
            <button className="btn btn-sm btn-quiet" onClick={() => setItem(null)}>
              {t('changeMatch')}
            </button>
          </div>
          <Field label={t('pack')}>
            <select className="select" value={packId} onChange={(e) => setPackId(e.target.value)}>
              {item.packs.map((p) => (
                <option key={p.id} value={p.id}>
                  {(lang === 'ar' && p.nameAr ? p.nameAr : p.name) + ` (${fmtQty(p.baseQty, item.baseUnit)})`}
                </option>
              ))}
            </select>
          </Field>
          <div className="form-row">
            <Field label={t('supplierSku')} hint={t('optional')}>
              <input className="input" value={sku} onChange={(e) => setSku(e.target.value)} dir="ltr" />
            </Field>
            <Field label={t('price')}>
              <input className="input num" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} dir="ltr" />
            </Field>
          </div>
          <Field label={t('supplierItemName')} hint={t('optional')}>
            <input className="input" value={supName} onChange={(e) => setSupName(e.target.value)} />
          </Field>
        </>
      )}
    </Dialog>
  );
}

function HistoryDialog({ line, onClose }: { line: SupplierLine; onClose: () => void }) {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const { data } = useApi<PriceHistoryRow[]>(`/supplier-items/${line.id}/prices`, [line.id]);
  return (
    <Dialog title={`${t('history')} · ${pick({ name: line.itemName, nameAr: line.itemNameAr })}`} onClose={onClose}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('when')}</th>
              <th className="end">{t('price')}</th>
              <th className="end">{t('change')}</th>
              <th>{t('result')}</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((h) => (
              <tr key={h.id}>
                <td className="num">{fmtDate(h.effectiveFrom)}</td>
                <td className="end num">{fmtMoney(h.price)}</td>
                <td className="end">
                  <ChangeTag pct={h.previousPrice ? ((Number(h.price) - Number(h.previousPrice)) / Number(h.previousPrice)) * 100 : null} />
                </td>
                <td>
                  <span className="tag">{t(`source_${h.source}` as TKey)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
