'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Dialog, Empty, Field, PageHead, initials } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { LegalEntity, Site, SiteType } from '@/lib/types';

export default function SitesPage() {
  const { t, pick } = useI18n();
  const { can } = useSession();
  const { data: sites, reload } = useApi<Site[]>('/sites');
  const [adding, setAdding] = useState(false);
  const canCreate = can('site:manage');

  return (
    <div className="page">
      <PageHead
        title={t('sites')}
        sub={t('sitesSub')}
        action={
          canCreate && (
            <button className="btn btn-primary" onClick={() => setAdding(true)}>
              <IconPlus /> {t('addSite')}
            </button>
          )
        }
      />
      {sites && sites.length === 0 && (
        <div className="card">
          <Empty
            title={t('noSites')}
            body={t('noSitesBody')}
            action={
              canCreate && (
                <button className="btn btn-primary" onClick={() => setAdding(true)}>
                  {t('addSite')}
                </button>
              )
            }
          />
        </div>
      )}
      <div className="grid-cards">
        {sites?.map((s) => (
          <Link key={s.id} href={`/sites/${s.id}`} className="card" style={{ color: 'inherit' }}>
            <div className="card-head">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center', minWidth: 0 }}>
                <span className="thumb">{s.code ? s.code.slice(0, 3).toUpperCase() : initials(pick(s))}</span>
                <div style={{ minWidth: 0 }}>
                  <div className="card-title">{pick(s)}</div>
                  <div className="muted" style={{ fontSize: 13 }}>
                    {[s.address?.district, s.address?.city].filter(Boolean).join('، ') || s.timezone}
                  </div>
                </div>
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <span className="tag">{t(s.type)}</span>
              <span className={`tag ${s.isActive ? 'tag-accent' : ''}`}>
                <span className="dot" />
                {s.isActive ? t('active') : t('inactive')}
              </span>
            </div>
          </Link>
        ))}
      </div>
      {adding && (
        <SiteDialog
          onClose={() => setAdding(false)}
          onSaved={() => {
            setAdding(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function SiteDialog({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const { data: entities } = useApi<LegalEntity[]>('/legal-entities');
  const [f, setF] = useState({ name: '', nameAr: '', code: '', type: 'restaurant' as SiteType, legalEntityId: '', city: '', district: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  const entityId = f.legalEntityId || entities?.[0]?.id || '';

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/sites', {
        method: 'POST',
        body: {
          legalEntityId: entityId,
          name: f.name,
          nameAr: f.nameAr || null,
          code: f.code || null,
          type: f.type,
          address: { city: f.city || undefined, district: f.district || undefined },
        },
      });
      onSaved();
    } catch (e) {
      const err = e as ApiError;
      setErrors(err.fieldErrors());
      setError(err.status === 409 ? `${t('siteCode')}: ${f.code}` : err.body?.issues ? null : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={t('addSite')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" disabled={busy || !f.name || !entityId} onClick={submit}>
            {t('save')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <div className="form-row">
        <Field label={t('siteName')} error={errors.name}>
          <input className="input" value={f.name} onChange={set('name')} />
        </Field>
        <Field label={t('siteNameAr')}>
          <input className="input" value={f.nameAr} onChange={set('nameAr')} dir="rtl" lang="ar" />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('siteType')}>
          <select className="select" value={f.type} onChange={set('type')}>
            <option value="restaurant">{t('restaurant')}</option>
            <option value="central_kitchen">{t('central_kitchen')}</option>
            <option value="warehouse">{t('warehouse')}</option>
          </select>
        </Field>
        <Field label={t('siteCode')} hint={t('optional')}>
          <input className="input" value={f.code} onChange={set('code')} dir="ltr" maxLength={30} />
        </Field>
      </div>
      <Field label={t('legalEntity')}>
        <select className="select" value={entityId} onChange={set('legalEntityId')}>
          {entities?.map((e) => (
            <option key={e.id} value={e.id}>
              {pick(e)}
            </option>
          ))}
        </select>
      </Field>
      <div className="form-row">
        <Field label={t('city')}>
          <input className="input" value={f.city} onChange={set('city')} />
        </Field>
        <Field label={t('district')}>
          <input className="input" value={f.district} onChange={set('district')} />
        </Field>
      </div>
    </Dialog>
  );
}
