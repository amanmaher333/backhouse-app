'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { Field, PageHead } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Site, SupplierDetail, SupplierRow } from '@/lib/types';

export default function NewOrderPage() {
  const { t, pick, lang, fmtMoney } = useI18n();
  const { api, me } = useSession();
  const router = useRouter();
  const { data: sites } = useApi<Site[]>('/sites');
  const { data: suppliers } = useApi<SupplierRow[]>('/suppliers');
  const [siteId, setSiteId] = useState('');
  const [relId, setRelId] = useState('');
  const [supplier, setSupplier] = useState<SupplierDetail | null>(null);
  const [qty, setQty] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canOrderAt = (sid: string) =>
    !!me?.memberships.some((m) => m.permissions.some((p) => p === '*' || p === 'po:manage' || p === 'po:*') && (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(sid)));
  const orderSites = sites?.filter((s) => s.isActive && canOrderAt(s.id)) ?? [];

  useEffect(() => {
    if (!siteId && orderSites[0]) setSiteId(orderSites[0].id);
  }, [orderSites, siteId]);
  useEffect(() => {
    setSupplier(null);
    setQty({});
    if (relId) api<SupplierDetail>(`/suppliers/${relId}`).then(setSupplier).catch(() => setSupplier(null));
  }, [api, relId]);

  const chosen = useMemo(() => (supplier?.items ?? []).filter((l) => l.isActive && Number(qty[l.id]) > 0), [supplier, qty]);
  const subtotal = chosen.reduce((s, l) => s + Number(qty[l.id]) * Number(l.currentPrice ?? 0), 0);
  const vat = subtotal * Number(supplier?.taxRate ?? 0.15);

  const save = async (submit: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const po = await api<{ id: string }>('/purchase-orders', {
        method: 'POST',
        body: {
          siteId,
          relationshipId: relId,
          deliveryDate: deliveryDate || null,
          notes: notes || null,
          submit,
          lines: chosen.map((l) => ({ supplierItemId: l.id, qty: Number(qty[l.id]) })),
        },
      });
      router.push(`/orders/${po.id}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead title={t('newOrder')} sub={t('addLineHint')} />
      {error && <div className="notice notice-error">{error}</div>}
      {sites && orderSites.length === 0 && (
        <div className="notice">
          {t('noSites')}. {t('noSitesBody')}
        </div>
      )}
      <section className="card">
        <div className="form-row">
          <Field label={t('site')}>
            <select className="select" value={siteId} onChange={(e) => setSiteId(e.target.value)}>
              {orderSites.map((s) => (
                <option key={s.id} value={s.id}>
                  {pick(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('supplier')}>
            <select className="select" value={relId} onChange={(e) => setRelId(e.target.value)}>
              <option value="">{t('pickSupplier')}</option>
              {suppliers?.map((s) => (
                <option key={s.id} value={s.id}>
                  {pick({ name: s.displayName, nameAr: s.displayNameAr })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('delivery')} hint={t('optional')}>
            <input className="input num" type="date" value={deliveryDate} onChange={(e) => setDeliveryDate(e.target.value)} dir="ltr" />
          </Field>
        </div>
      </section>

      {supplier && (
        <section className="card">
          <h2 className="card-title">{t('lines')}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('name')}</th>
                  <th className="hide-phone">{t('pack')}</th>
                  <th className="end">{t('unitPrice')}</th>
                  <th className="end">{t('qty')}</th>
                </tr>
              </thead>
              <tbody>
                {supplier.items
                  .filter((l) => l.isActive)
                  .map((l) => (
                    <tr key={l.id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{pick({ name: l.itemName, nameAr: l.itemNameAr })}</div>
                        <div className="faint" style={{ fontSize: 12 }}>
                          {l.supplierSku ?? l.itemCode}
                        </div>
                      </td>
                      <td className="hide-phone">{lang === 'ar' && l.packNameAr ? l.packNameAr : l.packName}</td>
                      <td className="end num">{fmtMoney(l.currentPrice)}</td>
                      <td className="end">
                        <input
                          className="input inline-input num"
                          style={{ width: 90, textAlign: 'end' }}
                          inputMode="decimal"
                          aria-label={`${t('qty')} ${l.itemName}`}
                          value={qty[l.id] ?? ''}
                          onChange={(e) => setQty({ ...qty, [l.id]: e.target.value })}
                        />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <Field label={t('poNotes')} hint={t('optional')}>
            <textarea className="input" style={{ minHeight: 70, padding: 12 }} value={notes} onChange={(e) => setNotes(e.target.value)} />
          </Field>
          <div className="totals">
            <span className="muted">{t('subtotal')}</span>
            <span className="num">{fmtMoney(subtotal)}</span>
            <span className="muted">{t('vat')}</span>
            <span className="num">{fmtMoney(vat)}</span>
            <strong>{t('total')}</strong>
            <strong className="num">{fmtMoney(subtotal + vat)}</strong>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <button className="btn btn-quiet" disabled={busy || chosen.length === 0 || !siteId} onClick={() => save(false)}>
              {t('saveDraft')}
            </button>
            <button className="btn btn-primary" disabled={busy || chosen.length === 0 || !siteId} onClick={() => save(true)}>
              {t('saveSubmit')}
            </button>
          </div>
        </section>
      )}
    </div>
  );
}
