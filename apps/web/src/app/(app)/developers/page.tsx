'use client';

import { useEffect, useState } from 'react';
import { ArmButton, Dialog, Field, PageHead } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';

interface Token {
  id: string;
  name: string;
  tokenPrefix: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  createdAt: string;
}

export default function DevelopersPage() {
  const { t, fmtDate } = useI18n();
  const { api } = useSession();
  const { data: tokens, reload } = useApi<Token[]>('/access-tokens');
  const [creating, setCreating] = useState(false);
  const [origin, setOrigin] = useState('');
  useEffect(() => setOrigin(window.location.origin), []);
  const endpoint = `${origin}/mcp`;
  const config = JSON.stringify(
    { mcpServers: { boh: { type: 'http', url: endpoint, headers: { Authorization: 'Bearer boh_pat_…' } } } },
    null,
    2,
  );

  return (
    <div className="page">
      <PageHead title={t('developers')} sub={t('developersSub')} />

      <section className="card">
        <h2 className="card-title">{t('mcpTitle')}</h2>
        <p className="muted" style={{ margin: 0 }}>
          {t('mcpHint')}
        </p>
        <div className="field">
          <span>{t('endpoint')}</span>
          <input className="input num" readOnly value={endpoint} dir="ltr" onFocus={(e) => e.target.select()} />
        </div>
        <pre className="code-block" dir="ltr">
          {config}
        </pre>
      </section>

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('tokens')}</h2>
          <button className="btn btn-sm btn-primary" onClick={() => setCreating(true)}>
            <IconPlus /> {t('newToken')}
          </button>
        </div>
        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
          {t('tokensHint')}
        </p>
        {tokens && tokens.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('tokenName')}</th>
                  <th className="hide-phone">{t('lastUsed')}</th>
                  <th className="hide-phone">{t('expires')}</th>
                  <th className="end" />
                </tr>
              </thead>
              <tbody>
                {tokens.map((tk) => (
                  <tr key={tk.id} style={{ opacity: tk.revokedAt ? 0.5 : 1 }}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{tk.name}</div>
                      <div className="faint num" style={{ fontSize: 12 }} dir="ltr">
                        {tk.tokenPrefix}…
                      </div>
                    </td>
                    <td className="hide-phone num">{tk.lastUsedAt ? fmtDate(tk.lastUsedAt) : '–'}</td>
                    <td className="hide-phone num">{tk.expiresAt ? fmtDate(tk.expiresAt) : t('never')}</td>
                    <td className="end">
                      {tk.revokedAt ? (
                        <span className="tag">{t('revoked')}</span>
                      ) : (
                        <ArmButton
                          label={t('revoke')}
                          onConfirm={async () => {
                            await api(`/access-tokens/${tk.id}`, { method: 'DELETE' });
                            reload();
                          }}
                        />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {creating && (
        <NewTokenDialog
          onClose={() => {
            setCreating(false);
            reload();
          }}
        />
      )}
    </div>
  );
}

function NewTokenDialog({ onClose }: { onClose: () => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [name, setName] = useState('');
  const [days, setDays] = useState('90');
  const [token, setToken] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (token) {
    return (
      <Dialog
        title={t('newToken')}
        onClose={onClose}
        actions={
          <>
            <button className="btn btn-quiet" onClick={onClose}>
              {t('close')}
            </button>
            <button
              className="btn btn-primary"
              onClick={async () => {
                await navigator.clipboard.writeText(token).catch(() => {});
                setCopied(true);
              }}
            >
              {copied ? t('copied') : t('copy')}
            </button>
          </>
        }
      >
        <div className="notice">{t('copyToken')}</div>
        <input className="input num" readOnly value={token} dir="ltr" onFocus={(e) => e.target.select()} />
      </Dialog>
    );
  }
  return (
    <Dialog
      title={t('newToken')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!name.trim()}
            onClick={async () => {
              try {
                const r = await api<{ token: string }>('/access-tokens', { method: 'POST', body: { name, expiresInDays: days ? Number(days) : null } });
                setToken(r.token);
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
      <Field label={t('tokenName')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Claude Desktop" />
      </Field>
      <Field label={t('expiresIn')} hint={t('optional')}>
        <input className="input num" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
      </Field>
    </Dialog>
  );
}
