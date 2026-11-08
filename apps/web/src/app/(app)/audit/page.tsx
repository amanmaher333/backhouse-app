'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import { Empty, PageHead, shortAgo } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useApi, useSession } from '@/lib/session';
import type { AuditEvent, Member } from '@/lib/types';

const SKIP = new Set(['id', 'orgId', 'createdAt', 'updatedAt']);

function diff(before: Record<string, unknown> | null, after: Record<string, unknown> | null) {
  const keys = new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]);
  const rows: { key: string; from: string; to: string }[] = [];
  for (const k of keys) {
    if (SKIP.has(k)) continue;
    const a = JSON.stringify(before?.[k] ?? null);
    const b = JSON.stringify(after?.[k] ?? null);
    if (a !== b) rows.push({ key: k, from: before ? a : '', to: after ? b : '' });
  }
  return rows;
}

export default function AuditPage() {
  const { t, lang, locale } = useI18n();
  const { api, can } = useSession();
  const { data: members } = useApi<Member[]>(can('member:read') ? '/members' : null);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [more, setMore] = useState(true);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(
    async (before?: number) => {
      const page = await api<AuditEvent[]>(`/audit-events?limit=50${before ? `&before=${before}` : ''}`);
      setEvents((prev) => (before ? [...prev, ...page] : page));
      setMore(page.length === 50);
    },
    [api],
  );
  useEffect(() => {
    load();
  }, [load]);

  const who = (id: string | null) => members?.find((m) => m.userId === id)?.fullName ?? (id ? id.slice(0, 8) : 'system');

  return (
    <div className="page">
      <PageHead title={t('audit')} sub={t('auditSub')} />
      {events.length === 0 ? (
        <div className="card">
          <Empty title={t('noEvents')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('when')}</th>
                <th>{t('who')}</th>
                <th>{t('action')}</th>
                <th>{t('entity')}</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <Fragment key={e.id}>
                  <tr onClick={() => setOpen(open === e.id ? null : e.id)} style={{ cursor: 'pointer' }}>
                    <td className="num muted" title={new Date(e.occurredAt).toLocaleString(locale)}>
                      {shortAgo(e.occurredAt, lang)}
                    </td>
                    <td>{who(e.actorUserId)}</td>
                    <td dir="ltr" style={{ textAlign: 'start' }}>
                      <span className="tag">{e.action}</span>
                    </td>
                    <td className="muted" dir="ltr" style={{ textAlign: 'start' }}>
                      {(e.after as any)?.name ?? (e.before as any)?.name ?? (e.after as any)?.email ?? e.entityType}
                    </td>
                  </tr>
                  {open === e.id && (
                    <tr>
                      <td colSpan={4} style={{ background: 'var(--tile)' }}>
                        <table className="table" dir="ltr">
                          <thead>
                            <tr>
                              <th />
                              <th>{t('before')}</th>
                              <th>{t('after')}</th>
                            </tr>
                          </thead>
                          <tbody>
                            {diff(e.before, e.after).map((r) => (
                              <tr key={r.key}>
                                <td style={{ fontWeight: 500 }}>{r.key}</td>
                                <td className="muted" style={{ wordBreak: 'break-all' }}>{r.from}</td>
                                <td style={{ wordBreak: 'break-all' }}>{r.to}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more && events.length > 0 && (
        <button className="btn btn-quiet" style={{ justifySelf: 'center' }} onClick={() => load(events[events.length - 1]!.id)}>
          {t('loadMore')}
        </button>
      )}
    </div>
  );
}
