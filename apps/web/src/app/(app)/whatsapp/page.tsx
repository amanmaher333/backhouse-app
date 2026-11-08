'use client';

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import { ArmButton, Empty, Field, PageHead, Toast } from '@/components/ui';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';

interface Mine {
  mode: 'cloud' | 'simulated';
  businessNumber: string;
  simulator: boolean;
  linked: { address: string; verifiedAt: string; approvalsEnabled: boolean; digestEnabled: boolean; digestHour: number; timeZone: string; windowOpen: boolean } | null;
}
interface LinkCode {
  code: string;
  expiresAt: string;
  waLink: string;
  businessNumber: string;
}
interface LogRow {
  id: string;
  kind: string;
  status: string;
  sentAs: string | null;
  error: string | null;
  createdAt: string;
  userName: string | null;
}

export default function WhatsAppPage() {
  const { t, fmtDate } = useI18n();
  const { api, can } = useSession();
  const { data: mine, reload } = useApi<Mine>('/me/whatsapp');
  const [code, setCode] = useState<LinkCode | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // While a code is out, check every few seconds whether the message arrived.
  useEffect(() => {
    if (!code || mine?.linked) return;
    const id = setInterval(reload, 3000);
    return () => clearInterval(id);
  }, [code, mine?.linked, reload]);
  useEffect(() => {
    if (code && mine?.linked) {
      setCode(null);
      setToast(t('linkedToast'));
    }
  }, [code, mine?.linked, t]);

  return (
    <div className="page">
      <PageHead title={t('whatsapp')} sub={t('whatsappSub')} />
      {error && <div className="notice notice-error">{error}</div>}

      <div className="wa-grid">
        <div className="wa-main">
          <section className="card">
            <h2 className="card-title">{t('yourNumber')}</h2>
            {!mine ? null : mine.linked ? (
              <>
                <div className="wa-linked">
                  <div>
                    <div className="num" dir="ltr" style={{ fontSize: 22, fontWeight: 600, textAlign: 'start' }}>
                      {mine.linked.address}
                    </div>
                    <div className="faint" style={{ fontSize: 13 }}>
                      {t('linkedOn')} · {fmtDate(mine.linked.verifiedAt)}
                      {mine.linked.windowOpen && <> · {t('windowOpen')}</>}
                    </div>
                  </div>
                  <ArmButton
                    label={t('unlink')}
                    onConfirm={async () => {
                      await api('/me/whatsapp', { method: 'DELETE' });
                      reload();
                    }}
                  />
                </div>
                <div className="wa-toggle">
                  <div>
                    <div style={{ fontWeight: 500 }}>{t('approvalCards')}</div>
                    <div className="faint" style={{ fontSize: 13 }}>
                      {t('approvalCardsHint')}
                    </div>
                  </div>
                  <button
                    className="switch"
                    role="switch"
                    aria-checked={mine.linked.approvalsEnabled}
                    aria-label={t('approvalCards')}
                    onClick={async () => {
                      await api('/me/whatsapp', { method: 'PATCH', body: { approvalsEnabled: !mine.linked!.approvalsEnabled } });
                      reload();
                    }}
                  />
                </div>
                <DigestPrefs linked={mine.linked} onChange={reload} onSent={() => setToast(t('digestSent'))} />
              </>
            ) : code ? (
              <div className="wa-code">
                <p className="muted" style={{ margin: 0 }}>
                  {t('sendThisCode')}
                </p>
                <div className="wa-code-value num" dir="ltr">
                  {code.code}
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                  <a className="btn btn-primary" href={code.waLink} target="_blank" rel="noreferrer">
                    {t('openWhatsApp')}
                  </a>
                  <span className="faint" style={{ fontSize: 13 }}>
                    {t('orSendTo')}{' '}
                    <bdi className="num" dir="ltr">
                      {code.businessNumber}
                    </bdi>
                  </span>
                </div>
                <div className="faint" style={{ fontSize: 13 }}>
                  {t('codeExpires')} <span className="wa-pulse">{t('waitingForCode')}</span>
                </div>
              </div>
            ) : (
              <Empty
                title={t('notLinked')}
                body={t('notLinkedBody')}
                action={
                  <button
                    className="btn btn-primary"
                    onClick={async () => {
                      try {
                        setCode(await api<LinkCode>('/me/whatsapp/link', { method: 'POST' }));
                      } catch (e) {
                        setError((e as ApiError).message);
                      }
                    }}
                  >
                    {t('getLinkCode')}
                  </button>
                }
              />
            )}
          </section>

          <section className="card">
            <h2 className="card-title">{t('howItWorks')}</h2>
            <ul className="wa-how">
              {(['how1', 'how2', 'how3', 'how4'] as const).map((k) => (
                <li key={k}>{t(k)}</li>
              ))}
            </ul>
          </section>

          {can('org:read') && mine && <OrgSettings mode={mine.mode} onSaved={() => setToast(t('saved'))} />}
          {can('audit:read') && <MessageLog />}
        </div>

        {mine?.simulator && <Simulator linked={!!mine.linked} onActivity={reload} />}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

const TIME_ZONES = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Kuwait', 'Asia/Muscat'];

function DigestPrefs({ linked, onChange, onSent }: { linked: NonNullable<Mine['linked']>; onChange: () => void; onSent: () => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [preview, setPreview] = useState<{ text: string; empty: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (body: Record<string, unknown>) => {
    await api('/me/whatsapp', { method: 'PATCH', body });
    onChange();
  };
  return (
    <div className="wa-digest">
      <div className="wa-toggle" style={{ borderTop: 0, marginTop: 0, paddingTop: 0 }}>
        <div>
          <div style={{ fontWeight: 500 }}>{t('dailyDigest')}</div>
          <div className="faint" style={{ fontSize: 13 }}>
            {t('dailyDigestHint')}
          </div>
        </div>
        <button className="switch" role="switch" aria-checked={linked.digestEnabled} aria-label={t('dailyDigest')} onClick={() => save({ digestEnabled: !linked.digestEnabled })} />
      </div>
      {linked.digestEnabled && (
        <div className="form-row">
          <Field label={t('digestTime')}>
            <select className="select num" value={linked.digestHour} onChange={(e) => save({ digestHour: Number(e.target.value) })}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={h} value={h}>
                  {String(h).padStart(2, '0')}:00
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('timeZone')}>
            <select className="select" value={linked.timeZone} onChange={(e) => save({ timeZone: e.target.value })}>
              {TIME_ZONES.map((z) => (
                <option key={z} value={z}>
                  {t(`tz_${z.replace('/', '_')}` as TKey)}
                </option>
              ))}
            </select>
          </Field>
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button
          className="btn btn-quiet btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              setPreview(await api<{ text: string; empty: boolean }>('/me/whatsapp/digest', { method: 'POST', body: { send: false } }));
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('previewDigest')}
        </button>
        <button
          className="btn btn-quiet btn-sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const r = await api<{ text: string; empty: boolean }>('/me/whatsapp/digest', { method: 'POST', body: { send: true } });
              setPreview(r);
              onSent();
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('sendDigestNow')}
        </button>
      </div>
      {preview && (
        <div className="wa-preview">
          {preview.empty && <div className="faint" style={{ fontSize: 13, marginBottom: 8 }}>{t('digestEmpty')}</div>}
          <div className="wa-bubble-text">{waText(preview.text)}</div>
        </div>
      )}
    </div>
  );
}

function OrgSettings({ mode, onSaved }: { mode: 'cloud' | 'simulated'; onSaved: () => void }) {
  const { t } = useI18n();
  const { api, can } = useSession();
  const { data } = useApi<{ whatsappApprovalMax: number }>('/channels/settings');
  const [max, setMax] = useState('');
  useEffect(() => {
    if (data) setMax(String(data.whatsappApprovalMax));
  }, [data]);
  const canManage = can('org:manage');
  return (
    <section className="card">
      <h2 className="card-title">{t('orgWhatsapp')}</h2>
      <div className={`notice ${mode === 'cloud' ? '' : 'notice-info'}`}>{mode === 'cloud' ? t('modeCloud') : t('modeSimulated')}</div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 260px' }}>
          <Field label={t('approvalLimit')}>
            <input className="input num" inputMode="decimal" value={max} disabled={!canManage} onChange={(e) => setMax(e.target.value)} dir="ltr" style={{ textAlign: 'start' }} />
          </Field>
        </div>
        {canManage && (
          <button
            className="btn btn-quiet"
            style={{ marginBottom: 18 }}
            disabled={max === '' || !Number.isFinite(Number(max)) || Number(max) < 0}
            onClick={async () => {
              await api('/channels/settings', { method: 'PATCH', body: { whatsappApprovalMax: Number(max) } });
              onSaved();
            }}
          >
            {t('save')}
          </button>
        )}
      </div>
    </section>
  );
}

function MessageLog() {
  const { t, lang } = useI18n();
  const { data: rows } = useApi<LogRow[]>('/channels/messages?limit=20');
  const time = (iso: string) =>
    new Date(iso).toLocaleString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <section className="card">
      <h2 className="card-title">{t('messageLog')}</h2>
      {rows && rows.length === 0 ? (
        <Empty title={t('noMessages')} />
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('time')}</th>
                <th>{t('person')}</th>
                <th>{t('kind')}</th>
                <th className="hide-phone">{t('sentAs')}</th>
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td className="num">{time(r.createdAt)}</td>
                  <td>{r.userName ?? '–'}</td>
                  <td>{t(`msg_${r.kind}` as TKey)}</td>
                  <td className="hide-phone faint">{r.sentAs ?? '–'}</td>
                  <td>
                    <span className={`tag ${r.status === 'failed' ? 'tag-late' : r.status === 'read' || r.status === 'delivered' ? 'tag-accent' : ''}`} title={r.error ?? undefined}>
                      {t(`ms_${r.status}` as TKey)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

interface ThreadItem {
  id: string;
  dir: 'in' | 'out';
  at: string;
  kind: string;
  content: { text: string; footer?: string; buttons?: { id: string; title: string }[] };
}

/** Renders WhatsApp's *bold* markup and keeps line breaks. */
function waText(text: string): ReactNode {
  return text.split('\n').map((line, i) => (
    <Fragment key={i}>
      {i > 0 && <br />}
      {line.split(/(\*[^*\n]+\*)/g).map((part, j) => (part.startsWith('*') && part.endsWith('*') && part.length > 2 ? <strong key={j}>{part.slice(1, -1)}</strong> : part))}
    </Fragment>
  ));
}

/** Development only: plays the person's phone while WhatsApp is simulated. */
function Simulator({ linked, onActivity }: { linked: boolean; onActivity: () => void }) {
  const { t, lang } = useI18n();
  const { api } = useSession();
  const [from, setFrom] = useState('');
  const [text, setText] = useState('');
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [used, setUsed] = useState<Set<string>>(new Set());
  const scroller = useRef<HTMLDivElement>(null);
  const qs = !linked && from ? `?from=${encodeURIComponent(from)}` : '';

  useEffect(() => {
    let alive = true;
    const load = () =>
      api<{ items: ThreadItem[] }>(`/me/whatsapp/simulator${qs}`)
        .then((r) => alive && setThread(r.items))
        .catch(() => undefined);
    load();
    const id = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [api, qs]);
  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [thread.length]);

  const send = async (body: { text?: string; payload?: string; title?: string }) => {
    await api('/me/whatsapp/simulator', { method: 'POST', body: { ...body, ...(linked ? {} : { from }) } });
    const r = await api<{ items: ThreadItem[] }>(`/me/whatsapp/simulator${linked ? '' : `?from=${encodeURIComponent(from)}`}`);
    setThread(r.items);
    onActivity();
  };
  const time = (iso: string) => new Date(iso).toLocaleTimeString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { hour: '2-digit', minute: '2-digit' });

  return (
    <aside className="wa-sim" aria-label={t('simulator')}>
      <div className="wa-sim-head">
        <strong>{t('simulator')}</strong>
        <span className="faint" style={{ fontSize: 12 }}>
          {t('simulatorSub')}
        </span>
      </div>
      <div className="wa-phone">
        <div className="wa-phone-bar">
          <span className="wa-avatar">B</span>
          <div>
            <div style={{ fontWeight: 600 }}>BOH</div>
            <div style={{ fontSize: 11, opacity: 0.8 }}>{t('whatsapp')}</div>
          </div>
        </div>
        <div className="wa-thread" ref={scroller}>
          {thread.map((m) => (
            <div key={m.id} className={`wa-bubble-row ${m.dir === 'in' ? 'from-boh' : 'from-me'}`}>
              <div className="wa-bubble">
                <div className="wa-bubble-text">{waText(m.content.text)}</div>
                {m.content.footer && <div className="wa-bubble-footer">{m.content.footer}</div>}
                <div className="wa-bubble-time num">{time(m.at)}</div>
                {m.content.buttons && m.content.buttons.length > 0 && (
                  <div className="wa-buttons">
                    {m.content.buttons.map((b) => (
                      <button
                        key={b.id}
                        disabled={used.has(m.id)}
                        onClick={async () => {
                          setUsed(new Set(used).add(m.id));
                          await send({ payload: b.id, title: b.title });
                        }}
                      >
                        {b.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>
        <form
          className="wa-compose"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!text.trim()) return;
            const body = text;
            setText('');
            await send({ text: body });
          }}
        >
          {!linked && (
            <input className="input num" dir="ltr" placeholder="05XXXXXXXX" aria-label={t('sendingFrom')} value={from} onChange={(e) => setFrom(e.target.value)} style={{ flex: '0 0 120px' }} />
          )}
          <input className="input" aria-label={t('typeMessage')} placeholder={t('typeMessage')} value={text} onChange={(e) => setText(e.target.value)} />
          <button className="btn btn-primary btn-sm" disabled={!text.trim() || (!linked && !from)}>
            {t('send')}
          </button>
        </form>
      </div>
    </aside>
  );
}
