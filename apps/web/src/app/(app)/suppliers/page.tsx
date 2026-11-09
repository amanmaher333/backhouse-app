'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Dialog, Empty, Field, PageHead } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { countryUi } from '@/lib/countries';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { OrderChannel, SupplierRow } from '@/lib/types';

export default function SuppliersPage() {
  const { t, pick, fmtDate } = useI18n();
  const { can } = useSession();
  const { data: suppliers } = useApi<SupplierRow[]>('/suppliers');
  const [adding, setAdding] = useState(false);
  const canManage = can('supplier:manage');

  return (
    <div className="page">
      <PageHead
        title={t('suppliers')}
        sub={t('suppliersSub')}
        action={
          canManage && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <IconPlus /> {t('addSupplier')}
            </button>
          )
        }
      />
      {suppliers && suppliers.length === 0 && (
        <div className="card">
          <Empty
            title={t('noSuppliers')}
            body={t('noSuppliersBody')}
            action={
              canManage && (
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  {t('addSupplier')}
                </button>
              )
            }
          />
        </div>
      )}
      <div className="grid-cards">
        {suppliers?.map((s) => (
          <Link key={s.id} href={`/suppliers/${s.id}`} className="card" style={{ color: 'inherit' }}>
            <div className="card-head">
              <div style={{ minWidth: 0 }}>
                <div className="card-title">{pick({ name: s.displayName, nameAr: s.displayNameAr })}</div>
                <div className="muted" style={{ fontSize: 13 }} dir="ltr">
                  {s.contactEmail ?? s.contactPhone ?? '–'}
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="tag">{t(`ch_${s.orderChannel}` as TKey)}</span>
              <span className="tag num">
                {s.itemCount} {t('items')}
              </span>
              {s.isClaimed ? <span className="tag tag-accent">{t('claimed')}</span> : <span className="tag">{t('unclaimed')}</span>}
            </div>
            {s.lastPriceChange && (
              <div className="faint" style={{ fontSize: 12 }}>
                {t('updated')} {fmtDate(s.lastPriceChange)}
              </div>
            )}
          </Link>
        ))}
      </div>
      {adding && <AddSupplierDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AddSupplierDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { api, org } = useSession();
  const router = useRouter();
  const [f, setF] = useState({
    displayName: '',
    displayNameAr: '',
    vatNumber: '',
    orderChannel: 'email' as OrderChannel,
    contactName: '',
    contactEmail: '',
    contactPhone: '',
    paymentTermsDays: '30',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <Dialog
      title={t('addSupplier')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !f.displayName}
            onClick={async () => {
              setBusy(true);
              setError(null);
              setErrors({});
              try {
                const s = await api<{ id: string }>('/suppliers', {
                  method: 'POST',
                  body: {
                    displayName: f.displayName,
                    displayNameAr: f.displayNameAr || null,
                    vatNumber: f.vatNumber || null,
                    orderChannel: f.orderChannel,
                    contactName: f.contactName || null,
                    contactEmail: f.contactEmail || null,
                    contactPhone: f.contactPhone || null,
                    paymentTermsDays: Number(f.paymentTermsDays || 0),
                  },
                });
                router.push(`/suppliers/${s.id}`);
              } catch (e) {
                const err = e as ApiError;
                if (err.status === 409 && err.body?.supplierId) return router.push(`/suppliers/${err.body.supplierId}`);
                setErrors(err.fieldErrors());
                setError(err.body?.issues ? null : err.message);
                setBusy(false);
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
        <Field label={t('supplierName')} error={errors.displayName}>
          <input className="input" value={f.displayName} onChange={set('displayName')} />
        </Field>
        <Field label={t('supplierNameAr')}>
          <input className="input" value={f.displayNameAr} onChange={set('displayNameAr')} dir="rtl" lang="ar" />
        </Field>
      </div>
      <Field label={t('vatNumber')} hint={t('vatHint')} error={errors.vatNumber}>
        <input className="input num" value={f.vatNumber} onChange={set('vatNumber')} dir="ltr" inputMode="numeric" maxLength={15} />
      </Field>
      <div className="form-row">
        <Field label={t('orderChannel')}>
          <select className="select" value={f.orderChannel} onChange={set('orderChannel')}>
            {(['email', 'whatsapp', 'portal', 'manual'] as const).map((c) => (
              <option key={c} value={c}>
                {t(`ch_${c}` as TKey)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('paymentTerms')}>
          <input className="input num" value={f.paymentTermsDays} onChange={set('paymentTermsDays')} inputMode="numeric" />
        </Field>
      </div>
      <Field label={t('contactName')}>
        <input className="input" value={f.contactName} onChange={set('contactName')} />
      </Field>
      <div className="form-row">
        <Field label={t('contactEmail')} error={errors.contactEmail}>
          <input className="input" type="email" value={f.contactEmail} onChange={set('contactEmail')} dir="ltr" />
        </Field>
        <Field label={t('contactPhone')} hint={countryUi(org?.country).phone} error={errors.contactPhone}>
          <input className="input" value={f.contactPhone} onChange={set('contactPhone')} dir="ltr" inputMode="tel" />
        </Field>
      </div>
    </Dialog>
  );
}
