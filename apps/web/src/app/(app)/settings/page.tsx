'use client';

import { useEffect, useState } from 'react';
import { Dialog, Field, PageHead, Toast } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { LegalEntity, Organization } from '@/lib/types';

export default function SettingsPage() {
  const { t, pick } = useI18n();
  const { api, can, reload: reloadMe } = useSession();
  const { data: org, reload } = useApi<Organization>('/org');
  const { data: entities, reload: reloadEntities } = useApi<LegalEntity[]>('/legal-entities');
  const [f, setF] = useState({ name: '', nameAr: '', defaultLocale: 'ar' });
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState<LegalEntity | 'new' | null>(null);
  const canManage = can('org:manage');

  useEffect(() => {
    if (org) setF({ name: org.name, nameAr: org.nameAr ?? '', defaultLocale: org.defaultLocale });
  }, [org]);

  return (
    <div className="page">
      <PageHead title={t('settings')} sub={t('settingsSub')} />

      <section className="card">
        <h2 className="card-title">{t('organization')}</h2>
        <div className="form-row">
          <Field label={t('orgName')}>
            <input className="input" value={f.name} disabled={!canManage} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label={t('orgNameAr')}>
            <input className="input" value={f.nameAr} disabled={!canManage} onChange={(e) => setF({ ...f, nameAr: e.target.value })} dir="rtl" lang="ar" />
          </Field>
        </div>
        <Field label={t('defaultLanguage')}>
          <div className="segmented" role="group">
            {(['ar', 'en'] as const).map((l) => (
              <button key={l} type="button" disabled={!canManage} aria-pressed={f.defaultLocale === l} onClick={() => setF({ ...f, defaultLocale: l })}>
                {l === 'ar' ? 'العربية' : 'English'}
              </button>
            ))}
          </div>
        </Field>
        {canManage && (
          <div>
            <button
              className="btn btn-primary"
              onClick={async () => {
                await api('/org', { method: 'PATCH', body: { name: f.name, nameAr: f.nameAr || null, defaultLocale: f.defaultLocale } });
                setToast(t('saved'));
                reload();
                reloadMe();
              }}
            >
              {t('save')}
            </button>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('legalEntities')}</h2>
          {can('legal_entity:manage') && (
            <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>
              <IconPlus /> {t('addEntity')}
            </button>
          )}
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('legalName')}</th>
                <th>{t('vatNumber')}</th>
                <th>{t('crNumber')}</th>
                <th className="end" />
              </tr>
            </thead>
            <tbody>
              {entities?.map((e) => (
                <tr key={e.id}>
                  <td style={{ fontWeight: 500 }}>{pick(e)}</td>
                  <td className="num" dir="ltr" style={{ textAlign: 'start' }}>
                    {e.vatNumber ?? '–'}
                  </td>
                  <td className="num" dir="ltr" style={{ textAlign: 'start' }}>
                    {e.crNumber ?? '–'}
                  </td>
                  <td className="end">
                    {can('legal_entity:manage') && (
                      <button className="btn btn-sm btn-quiet" onClick={() => setEditing(e)}>
                        {t('edit')}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {editing && (
        <EntityDialog
          entity={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setToast(t('saved'));
            reloadEntities();
          }}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function EntityDialog({ entity, onClose, onSaved }: { entity: LegalEntity | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [f, setF] = useState({
    name: entity?.name ?? '',
    nameAr: entity?.nameAr ?? '',
    vatNumber: entity?.vatNumber ?? '',
    crNumber: entity?.crNumber ?? '',
    city: entity?.address?.city ?? '',
    district: entity?.address?.district ?? '',
    street: entity?.address?.street ?? '',
    buildingNumber: entity?.address?.buildingNumber ?? '',
    postalCode: entity?.address?.postalCode ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <Dialog
      title={entity ? t('edit') : t('addEntity')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!f.name}
            onClick={async () => {
              setError(null);
              setErrors({});
              const body = {
                name: f.name,
                nameAr: f.nameAr || null,
                vatNumber: f.vatNumber || null,
                crNumber: f.crNumber || null,
                address: {
                  city: f.city || undefined,
                  district: f.district || undefined,
                  street: f.street || undefined,
                  buildingNumber: f.buildingNumber || undefined,
                  postalCode: f.postalCode || undefined,
                },
              };
              try {
                if (entity) await api(`/legal-entities/${entity.id}`, { method: 'PATCH', body });
                else await api('/legal-entities', { method: 'POST', body });
                onSaved();
              } catch (e) {
                const err = e as ApiError;
                setErrors(err.fieldErrors());
                setError(err.body?.issues ? null : err.message);
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
        <Field label={t('legalName')} error={errors.name}>
          <input className="input" value={f.name} onChange={set('name')} />
        </Field>
        <Field label={t('orgNameAr')}>
          <input className="input" value={f.nameAr} onChange={set('nameAr')} dir="rtl" lang="ar" />
        </Field>
      </div>
      <div className="form-row">
        <Field label={t('vatNumber')} hint={t('vatHint')} error={errors.vatNumber}>
          <input className="input num" value={f.vatNumber} onChange={set('vatNumber')} dir="ltr" inputMode="numeric" maxLength={15} />
        </Field>
        <Field label={t('crNumber')} hint={t('crHint')} error={errors.crNumber}>
          <input className="input num" value={f.crNumber} onChange={set('crNumber')} dir="ltr" inputMode="numeric" maxLength={10} />
        </Field>
      </div>
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
