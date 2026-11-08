'use client';

import { useState } from 'react';
import { ArmButton, Dialog, Field, PageHead } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Role } from '@/lib/types';

export default function RolesPage() {
  const { t, pick } = useI18n();
  const { api, can } = useSession();
  const canManage = can('role:manage');
  const { data: roles, reload } = useApi<Role[]>('/roles');
  const [editing, setEditing] = useState<Role | 'new' | null>(null);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="page">
      <PageHead
        title={t('roles')}
        sub={t('rolesSub')}
        action={
          canManage && (
            <button className="btn btn-primary" onClick={() => setEditing('new')}>
              <IconPlus /> {t('addRole')}
            </button>
          )
        }
      />
      {error && <div className="notice notice-error">{error}</div>}
      <div className="grid-cards">
        {roles?.map((r) => (
          <section key={r.id} className="card">
            <div className="card-head">
              <h2 className="card-title">{pick(r)}</h2>
              <span className={`tag ${r.isSystem ? '' : 'tag-accent'}`}>{r.isSystem ? t('system') : t('custom')}</span>
            </div>
            <div className="muted" style={{ fontSize: 13 }}>
              {t('scope')}: {r.scope === 'org' ? t('scopeOrg') : t('scopeSite')}
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }} dir="ltr">
              {r.permissions.map((p) => (
                <span key={p} className="tag">
                  {p}
                </span>
              ))}
            </div>
            {canManage && !r.isSystem && (
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-sm btn-quiet" onClick={() => setEditing(r)}>
                  {t('edit')}
                </button>
                <ArmButton
                  label={t('remove')}
                  onConfirm={async () => {
                    try {
                      setError(null);
                      await api(`/roles/${r.id}`, { method: 'DELETE' });
                    } catch (e) {
                      setError((e as ApiError).message);
                    }
                    reload();
                  }}
                />
              </div>
            )}
          </section>
        ))}
      </div>
      {editing && (
        <RoleDialog
          role={editing === 'new' ? null : editing}
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

function RoleDialog({ role, onClose, onSaved }: { role: Role | null; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const { data: catalogue } = useApi<string[]>('/permissions');
  const [f, setF] = useState({ key: role?.key ?? '', name: role?.name ?? '', nameAr: role?.nameAr ?? '', scope: role?.scope ?? 'org' });
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const groups = new Map<string, string[]>();
  catalogue?.forEach((p) => {
    const [res] = p.split(':');
    groups.set(res!, [...(groups.get(res!) ?? []), p]);
  });

  return (
    <Dialog
      title={role ? t('edit') : t('addRole')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !f.name || perms.length === 0}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                if (role) await api(`/roles/${role.id}`, { method: 'PATCH', body: { name: f.name, nameAr: f.nameAr || null, permissions: perms } });
                else await api('/roles', { method: 'POST', body: { ...f, nameAr: f.nameAr || null, permissions: perms } });
                onSaved();
              } catch (e) {
                const err = e as ApiError;
                setErrors(err.fieldErrors());
                setError(err.body?.issues ? null : err.message);
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
      <div className="form-row">
        <Field label={t('roleName')} error={errors.name}>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label={t('roleNameAr')}>
          <input className="input" value={f.nameAr} onChange={(e) => setF({ ...f, nameAr: e.target.value })} dir="rtl" lang="ar" />
        </Field>
      </div>
      {!role && (
        <div className="form-row">
          <Field label={t('roleKey')} hint="e.g. head_chef" error={errors.key}>
            <input className="input" value={f.key} onChange={(e) => setF({ ...f, key: e.target.value })} dir="ltr" />
          </Field>
          <Field label={t('scope')}>
            <select className="select" value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as 'org' | 'site' })}>
              <option value="org">{t('scopeOrg')}</option>
              <option value="site">{t('scopeSite')}</option>
            </select>
          </Field>
        </div>
      )}
      <div className="field">
        <span>{t('permissions')}</span>
        <div style={{ display: 'grid', gap: 4 }} dir="ltr">
          {[...groups.entries()].map(([res, list]) => (
            <div key={res} style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px', alignItems: 'center' }}>
              <strong style={{ minWidth: 110, fontWeight: 500 }}>{res}</strong>
              {list.map((p) => (
                <label key={p} className="check">
                  <input type="checkbox" checked={perms.includes(p)} onChange={(e) => setPerms(e.target.checked ? [...perms, p] : perms.filter((x) => x !== p))} />
                  {p.split(':')[1]}
                </label>
              ))}
            </div>
          ))}
        </div>
      </div>
    </Dialog>
  );
}
