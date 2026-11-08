'use client';

import { useState } from 'react';
import { ArmButton, Dialog, Field, PageHead, initials } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Invitation, Member, Role, Site } from '@/lib/types';

export default function MembersPage() {
  const { t, pick, fmtDate } = useI18n();
  const { api, can, me } = useSession();
  const canManage = can('member:manage');
  const { data: members, reload } = useApi<Member[]>('/members');
  const { data: roles } = useApi<Role[]>('/roles');
  const { data: sites } = useApi<Site[]>('/sites');
  const { data: invites, reload: reloadInvites } = useApi<Invitation[]>(canManage ? '/invitations' : null);
  const [inviting, setInviting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const roleById = new Map(roles?.map((r) => [r.id, r]));
  const siteNames = (ids: string[] | null) =>
    ids === null ? t('allSites') : ids.map((id) => sites?.find((s) => s.id === id)).filter(Boolean).map((s) => pick(s!)).join('، ');

  return (
    <div className="page">
      <PageHead
        title={t('members')}
        sub={t('membersSub')}
        action={
          canManage && (
            <button className="btn btn-primary" onClick={() => setInviting(true)}>
              <IconPlus /> {t('invite')}
            </button>
          )
        }
      />
      {error && <div className="notice notice-error">{error}</div>}

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('fullName')}</th>
              <th>{t('role')}</th>
              <th>{t('sites')}</th>
              {canManage && <th className="end" />}
            </tr>
          </thead>
          <tbody>
            {members?.map((m) => (
              <tr key={m.membershipId}>
                <td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span className="avatar">{initials(m.fullName)}</span>
                    <div>
                      <div style={{ fontWeight: 500 }}>{m.fullName}</div>
                      <div className="faint" style={{ fontSize: 12 }} dir="ltr">
                        {m.email}
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  {canManage && m.userId !== me?.user.id ? (
                    <select
                      className="select"
                      style={{ minHeight: 44, width: 'auto' }}
                      value={m.roleId}
                      aria-label={t('changeRole')}
                      onChange={async (e) => {
                        const role = roleById.get(e.target.value);
                        try {
                          setError(null);
                          await api(`/members/${m.membershipId}`, {
                            method: 'PATCH',
                            body: { roleId: e.target.value, siteIds: role?.scope === 'org' ? null : m.siteIds },
                          });
                        } catch (err) {
                          setError((err as ApiError).message);
                        }
                        reload();
                      }}
                    >
                      {roles?.map((r) => (
                        <option key={r.id} value={r.id}>
                          {pick(r)}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="tag">{pick(roleById.get(m.roleId) ?? { name: m.roleName })}</span>
                  )}
                </td>
                <td className="muted">{m.scope === 'org' ? t('scopeOrg') : siteNames(m.siteIds)}</td>
                {canManage && (
                  <td className="end">
                    {m.userId !== me?.user.id && (
                      <ArmButton
                        label={t('remove')}
                        onConfirm={async () => {
                          try {
                            setError(null);
                            await api(`/members/${m.membershipId}`, { method: 'DELETE' });
                          } catch (err) {
                            setError((err as ApiError).message);
                          }
                          reload();
                        }}
                      />
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {canManage && invites && invites.length > 0 && (
        <section className="card">
          <h2 className="card-title">{t('pendingInvites')}</h2>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {invites.map((i) => (
                  <tr key={i.id}>
                    <td dir="ltr" style={{ textAlign: 'start' }}>
                      {i.email}
                    </td>
                    <td>
                      <span className="tag">{pick(roleById.get(i.roleId) ?? { name: '' })}</span>
                    </td>
                    <td className="muted num">
                      {t('expires')} {fmtDate(i.expiresAt)}
                    </td>
                    <td className="end">
                      <ArmButton
                        label={t('revoke')}
                        onConfirm={async () => {
                          await api(`/invitations/${i.id}`, { method: 'DELETE' });
                          reloadInvites();
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {inviting && roles && (
        <InviteDialog
          roles={roles}
          sites={sites ?? []}
          onClose={() => {
            setInviting(false);
            reloadInvites();
          }}
        />
      )}
    </div>
  );
}

function InviteDialog({ roles, sites, onClose }: { roles: Role[]; sites: Site[]; onClose: () => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState(roles.find((r) => r.key === 'staff')?.id ?? roles[0]?.id ?? '');
  const [limit, setLimit] = useState(false);
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const role = roles.find((r) => r.id === roleId);
  const siteScoped = role?.scope === 'site';

  if (link) {
    return (
      <Dialog
        title={t('inviteLink')}
        onClose={onClose}
        actions={
          <>
            <button className="btn btn-quiet" onClick={onClose}>
              {t('close')}
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                await navigator.clipboard.writeText(link).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? t('copied') : t('copy')}
            </button>
          </>
        }
      >
        <p className="muted" style={{ margin: 0 }}>
          {t('inviteLinkHint')}
        </p>
        <input className="input" readOnly value={link} dir="ltr" onFocus={(e) => e.target.select()} />
      </Dialog>
    );
  }

  return (
    <Dialog
      title={t('inviteTitle')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !email || (siteScoped && limit && siteIds.length === 0)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const inv = await api<{ token: string }>('/invitations', {
                  method: 'POST',
                  body: { email, roleId, siteIds: siteScoped && limit ? siteIds : null },
                });
                setLink(`${window.location.origin}/invite?token=${encodeURIComponent(inv.token)}`);
              } catch (e) {
                const err = e as ApiError;
                setError(err.fieldErrors().email ?? err.message);
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('invite')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <Field label={t('email')}>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
      </Field>
      <Field label={t('role')}>
        <select className="select" value={roleId} onChange={(e) => setRoleId(e.target.value)}>
          {roles.map((r) => (
            <option key={r.id} value={r.id}>
              {pick(r)} · {r.scope === 'org' ? t('scopeOrg') : t('scopeSite')}
            </option>
          ))}
        </select>
      </Field>
      {siteScoped && (
        <div className="form-grid" style={{ gap: 4 }}>
          <div className="segmented" role="group">
            <button type="button" aria-pressed={!limit} onClick={() => setLimit(false)}>
              {t('allSites')}
            </button>
            <button type="button" aria-pressed={limit} onClick={() => setLimit(true)}>
              {t('limitSites')}
            </button>
          </div>
          {limit &&
            sites.map((s) => (
              <label key={s.id} className="check">
                <input
                  type="checkbox"
                  checked={siteIds.includes(s.id)}
                  onChange={(e) => setSiteIds(e.target.checked ? [...siteIds, s.id] : siteIds.filter((x) => x !== s.id))}
                />
                {pick(s)}
              </label>
            ))}
        </div>
      )}
    </Dialog>
  );
}
