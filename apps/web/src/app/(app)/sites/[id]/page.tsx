'use client';

import { useParams } from 'next/navigation';
import { useState } from 'react';
import { ArmButton, Dialog, Empty, Field, PageHead, initials } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Site, StorageLocation } from '@/lib/types';

export default function SitePage() {
  const { id } = useParams<{ id: string }>();
  const { t, pick } = useI18n();
  const { api, me } = useSession();
  const { data: site, error, reload: reloadSite } = useApi<Site>(`/sites/${id}`, [id]);
  const { data: locations, reload } = useApi<StorageLocation[]>(`/sites/${id}/locations`, [id]);
  const [editing, setEditing] = useState<StorageLocation | 'new' | null>(null);

  // Site-level permission check (a site manager may manage locations only for their sites).
  const canManageLocations = !!me?.memberships.some(
    (m) =>
      m.permissions.some((p) => p === '*' || p === 'location:manage' || p === 'location:*') &&
      (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(id)),
  );
  const canManageSite = !!me?.memberships.some(
    (m) =>
      m.permissions.some((p) => p === '*' || p === 'site:manage' || p === 'site:*') &&
      (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(id)),
  );

  if (error) return <div className="notice notice-error">{error.message}</div>;
  if (!site) return <div className="muted">{t('loading')}</div>;

  return (
    <div className="page">
      <PageHead
        title={pick(site)}
        sub={`${t(site.type)}${site.code ? ` · ${site.code}` : ''}`}
        action={
          canManageSite && (
            <button
              className="btn btn-quiet"
              onClick={async () => {
                await api(`/sites/${id}`, { method: 'PATCH', body: { isActive: !site.isActive } });
                reloadSite();
              }}
            >
              <span className={`tag ${site.isActive ? 'tag-accent' : ''}`}>
                <span className="dot" />
                {site.isActive ? t('active') : t('inactive')}
              </span>
            </button>
          )
        }
      />

      <div className="grid-cards" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))' }}>
        <section className="card span-2">
          <div className="card-head">
            <h2 className="card-title">{t('locations')}</h2>
            {canManageLocations && (
              <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>
                <IconPlus /> {t('addLocation')}
              </button>
            )}
          </div>
          {locations && locations.length === 0 ? (
            <Empty title={t('noLocations')} body={t('noLocationsBody')} />
          ) : (
            <div style={{ display: 'grid', gap: 8 }}>
              {locations?.map((l) => (
                <div key={l.id} style={{ display: 'flex', alignItems: 'center', gap: 12, minHeight: 64, padding: '8px 12px', border: '1px solid var(--line)', borderRadius: 12 }}>
                  <span className="thumb">{initials(pick(l))}</span>
                  <span style={{ flex: 1, fontWeight: 500 }}>{pick(l)}</span>
                  {canManageLocations && (
                    <>
                      <button className="btn btn-sm btn-quiet" onClick={() => setEditing(l)}>
                        {t('edit')}
                      </button>
                      <ArmButton
                        label={t('remove')}
                        onConfirm={async () => {
                          await api(`/sites/${id}/locations/${l.id}`, { method: 'DELETE' });
                          reload();
                        }}
                      />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="card">
          <h2 className="card-title">{t('details')}</h2>
          <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px' }}>
            <dt className="muted">{t('city')}</dt>
            <dd style={{ margin: 0 }}>{site.address?.city || '–'}</dd>
            <dt className="muted">{t('district')}</dt>
            <dd style={{ margin: 0 }}>{site.address?.district || '–'}</dd>
            <dt className="muted">{t('timezone')}</dt>
            <dd style={{ margin: 0 }} dir="ltr">
              {site.timezone}
            </dd>
          </dl>
        </section>
      </div>

      {editing && (
        <LocationDialog
          siteId={id}
          location={editing === 'new' ? null : editing}
          nextSort={(locations?.length ?? 0) + 1}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload();
          }}
        />
      )}
    </div>
  );
}

function LocationDialog({ siteId, location, nextSort, onClose, onSaved }: { siteId: string; location: StorageLocation | null; nextSort: number; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [name, setName] = useState(location?.name ?? '');
  const [nameAr, setNameAr] = useState(location?.nameAr ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <Dialog
      title={location ? t('edit') : t('addLocation')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !name}
            onClick={async () => {
              setBusy(true);
              try {
                const body = { name, nameAr: nameAr || null };
                if (location) await api(`/sites/${siteId}/locations/${location.id}`, { method: 'PATCH', body });
                else await api(`/sites/${siteId}/locations`, { method: 'POST', body: { ...body, sortOrder: nextSort } });
                onSaved();
              } catch (e) {
                setError((e as ApiError).message);
              } finally {
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
      <Field label={t('locationName')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label={t('locationNameAr')}>
        <input className="input" value={nameAr} onChange={(e) => setNameAr(e.target.value)} dir="rtl" lang="ar" />
      </Field>
    </Dialog>
  );
}
