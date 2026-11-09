'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Dialog, Empty, Field, PageHead, Toast, shortAgo } from '@/components/ui';
import { ChangeTag } from '@/components/catalog';
import { IconBot } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';

interface Action {
  id: string;
  type: string;
  label: string;
  labelAr: string;
  params: Record<string, any>;
  autonomy?: 'suggest' | 'approve' | 'auto';
}
interface Task {
  id: string;
  kind: string;
  status: string;
  priority: number;
  title: string;
  titleAr: string;
  summary: string;
  summaryAr: string;
  evidence: Record<string, any>;
  actions: Action[];
  chosenActionId: string | null;
  result: Record<string, any> | null;
  error: string | null;
  writtenBy: 'claude' | 'template';
  decidedAt: string | null;
  decisionNote: string | null;
  decidedVia: 'web' | 'whatsapp' | 'api' | 'auto' | null;
  createdAt: string;
  updatedAt: string;
  agent: { kind: string; name: string; nameAr: string | null; status: string };
}

export default function InboxPage() {
  const { t } = useI18n();
  const { can } = useSession();
  const [tab, setTab] = useState<'open' | 'closed'>('open');
  const { data: tasks, reload } = useApi<Task[]>(`/agent-tasks?status=${tab}&limit=100`, [tab]);
  const { data: agentsInfo } = useApi<{ installed: unknown[] }>('/agents');
  const [toast, setToast] = useState<string | null>(null);
  const noAgents = agentsInfo && agentsInfo.installed.length === 0;
  // Links from WhatsApp cards open /inbox?task=<id>: show that task, wherever it is.
  const [focus, setFocus] = useState<string | null>(null);
  useEffect(() => {
    setFocus(new URLSearchParams(window.location.search).get('task'));
  }, []);
  useEffect(() => {
    if (!focus || !tasks) return;
    const el = document.getElementById(`task-${focus}`);
    if (el) {
      el.scrollIntoView({ block: 'center' });
      return;
    }
    if (tab === 'open') setTab('closed');
  }, [focus, tasks, tab]);

  return (
    <div className="page">
      <PageHead
        title={t('inbox')}
        sub={t('inboxSub')}
        action={
          <div className="segmented" role="group">
            <button aria-pressed={tab === 'open'} onClick={() => setTab('open')}>
              {t('open')}
            </button>
            <button aria-pressed={tab === 'closed'} onClick={() => setTab('closed')}>
              {t('closedTab')}
            </button>
          </div>
        }
      />

      {noAgents ? (
        <div className="card">
          <Empty
            title={t('noAgentsYet')}
            body={t('noAgentsYetBody')}
            action={
              can('agent:manage') && (
                <Link className="btn btn-primary" href="/agents">
                  {t('hire')}
                </Link>
              )
            }
          />
        </div>
      ) : tasks && tasks.length === 0 ? (
        <div className="card">
          <Empty title={t('noTasks')} body={t('noTasksBody')} />
        </div>
      ) : (
        <div className="task-list">
          {tasks?.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              focused={task.id === focus}
              onChanged={(msg) => {
                if (msg) setToast(msg);
                reload();
                window.dispatchEvent(new Event('boh:inbox-changed'));
              }}
            />
          ))}
        </div>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function TaskCard({ task, focused, onChanged }: { task: Task; focused?: boolean; onChanged: (msg?: string) => void }) {
  const { t, lang, fmtMoney, pick, fmtDate } = useI18n();
  const { api, can } = useSession();
  const [busy, setBusy] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [showMessage, setShowMessage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ar = lang === 'ar';
  const ev = task.evidence;
  const open = task.status === 'proposed' || task.status === 'approved';
  const canDecide = can('task:decide');
  const contact = task.actions.find((a) => a.type === 'contact_supplier' || a.type === 'request_credit_note');
  const result = task.result ?? {};

  const approve = async (a: Action) => {
    setBusy(a.id);
    setError(null);
    try {
      const done = await api<Task>(`/agent-tasks/${task.id}/approve`, { method: 'POST', body: { actionId: a.id } });
      if (done.status === 'executed' && done.result?.mailto && (a.type === 'contact_supplier' || a.type === 'request_credit_note')) {
        // Open the prepared message so the person can send it.
        const url = done.result.whatsapp && task.evidence.supplier?.channel === 'whatsapp' ? done.result.whatsapp : done.result.mailto ?? done.result.whatsapp;
        if (url) window.open(url, '_blank', 'noopener');
      }
      onChanged(done.status === 'failed' ? done.error ?? '' : undefined);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <article id={`task-${task.id}`} className={`card task-card ${task.priority === 1 && open ? 'task-high' : ''} ${focused ? 'task-focus' : ''}`}>
      <header className="task-head">
        <span className="tag tag-accent">
          <IconBot width={14} height={14} />
          {ar ? task.agent.nameAr ?? task.agent.name : task.agent.name}
        </span>
        {task.priority === 1 && open && <span className="tag tag-late">{t('highPriority')}</span>}
        {!open && <span className={`tag ${task.status === 'executed' ? 'tag-accent' : task.status === 'failed' ? 'tag-late' : ''}`}>{t(`st_${task.status}` as TKey)}</span>}
        {!open && task.decidedVia && task.decidedVia !== 'web' && <span className="tag">{t(`via_${task.decidedVia}` as TKey)}</span>}
        <span className="faint num" style={{ marginInlineStart: 'auto', fontSize: 12 }}>
          {shortAgo(task.updatedAt, lang)}
        </span>
      </header>

      <div>
        <h2 className="card-title" style={{ marginBottom: 4 }}>
          {ar ? task.titleAr : task.title}
        </h2>
        <p className="muted" style={{ margin: 0 }}>
          {ar ? task.summaryAr : task.summary}
        </p>
      </div>

      {task.kind === 'price_rise' && (
        <div className="evidence">
          <div className="evidence-main">
            <div>
              <div className="stat-label">{pick({ name: ev.item?.name, nameAr: ev.item?.nameAr })}</div>
              <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
                {fmtMoney(ev.newPrice)} <ChangeTag pct={ev.changePct} />
              </div>
              <div className="faint num" style={{ fontSize: 12 }}>
                {t('priceWas')} {fmtMoney(ev.previousPrice)} · {pick({ name: ev.supplier?.name, nameAr: ev.supplier?.nameAr })} · {pick({ name: ev.pack?.name, nameAr: ev.pack?.nameAr })}
              </div>
            </div>
            {ev.history?.length > 1 && (
              <Spark values={[...ev.history].reverse().map((h: any) => Number(h.price))} />
            )}
          </div>
          {ev.alternatives?.length > 0 && (
            <div>
              <div className="stat-label" style={{ marginBottom: 6 }}>
                {t('cheaperOptions')}
              </div>
              <div className="table-wrap">
                <table className="table">
                  <tbody>
                    {ev.alternatives.map((alt: any) => (
                      <tr key={alt.supplierItemId}>
                        <td>{ar ? alt.supplierAr : alt.supplier}</td>
                        <td className="faint hide-phone">{ar ? alt.itemAr : alt.item}</td>
                        <td className="end num">
                          {fmtMoney(alt.costPerUnit)} / {ar ? ev.costPerUnit?.unitAr : ev.costPerUnit?.unit}
                        </td>
                        <td className="end">
                          <span className="tag tag-accent num" dir="ltr">
                            -{alt.savingPct}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {task.kind === 'reorder' && (
        <div className="evidence">
          <div className="evidence-main">
            <div>
              <div className="stat-label">
                {pick({ name: ev.supplier?.name, nameAr: ev.supplier?.nameAr })} · {pick({ name: ev.site?.name, nameAr: ev.site?.nameAr })}
              </div>
              <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
                {fmtMoney(ev.total)}
              </div>
              <div className="faint num" style={{ fontSize: 12 }}>
                {t('delivery')} {ev.deliveryDate ? fmtDate(ev.deliveryDate) : '–'} · {t('vat')} {fmtMoney(ev.tax)}
              </div>
            </div>
          </div>
          {ev.belowMinimum && <div className="notice">{t('belowMinimum')}</div>}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('name')}</th>
                  <th className="end">{t('onHand')}</th>
                  <th className="end hide-phone">{t('par')}</th>
                  <th className="end">{t('qty')}</th>
                  <th className="end hide-phone">{t('lineTotal')}</th>
                </tr>
              </thead>
              <tbody>
                {ev.lines?.map((l: any) => (
                  <tr key={l.supplierItemId}>
                    <td>{ar ? l.itemAr : l.item}</td>
                    <td className="end num">{ar ? l.onHandAr ?? l.onHand : l.onHand}</td>
                    <td className="end num hide-phone">{ar ? l.parAr ?? l.par : l.par}</td>
                    <td className="end num">
                      {l.qty} × {ar ? l.packAr : l.pack}
                    </td>
                    <td className="end num hide-phone">{fmtMoney(l.lineTotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {ev.skipped?.uncounted > 0 && (
            <div className="faint" style={{ fontSize: 12 }}>
              {ev.skipped.uncounted} {t('skippedUncounted')}
            </div>
          )}
        </div>
      )}

      {task.kind === 'po_overdue' && (
        <div className="evidence">
          <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
            {ev.daysLate} <span style={{ fontSize: 14, fontWeight: 500 }}>{t('daysLate')}</span>
          </div>
          <div className="faint num" style={{ fontSize: 12 }}>
            {ev.number} · {t('delivery')} {ev.deliveryDate ? fmtDate(ev.deliveryDate) : '–'} · {fmtMoney(ev.total)}
          </div>
        </div>
      )}

      {task.kind.startsWith('invoice_') && (
        <div className="evidence">
          <div className="evidence-main">
            <div className="num" style={{ fontSize: 22, fontWeight: 700 }}>
              {fmtMoney(ev.total)}
            </div>
            {Number(ev.claimTotal) > 0 && task.kind === 'invoice_dispute' && (
              <span className="tag tag-late num">
                {fmtMoney(ev.claimTotal)} {t('over')}
              </span>
            )}
          </div>
          <div className="faint num" style={{ fontSize: 12 }}>
            {[ev.number ?? ev.ref, ev.poNumber, ev.site ? pick(ev.site) : null, ev.dueDate ? `${t('dueDate')} ${fmtDate(ev.dueDate)}` : null].filter(Boolean).join(' · ')}
          </div>
          {task.kind === 'invoice_dispute' && Array.isArray(ev.discrepancies) && ev.discrepancies.length > 0 && (
            <ul className="diff-list" style={{ marginTop: 8 }}>
              {ev.discrepancies.slice(0, 4).map((d: { message: string; messageAr: string; amount: string }, i: number) => (
                <li key={i}>
                  <span>{ar ? d.messageAr : d.message}</span>
                  {Number(d.amount) > 0 && <span className="amount num">{fmtMoney(d.amount)}</span>}
                </li>
              ))}
            </ul>
          )}
          <div style={{ marginTop: 8 }}>
            <Link className="btn btn-sm btn-quiet" href={`/invoices/${ev.invoiceId}`}>
              {t('openInvoice')}
            </Link>
          </div>
        </div>
      )}

      {(task.kind === 'po_overdue' || task.kind === 'supplier_reply') && ev.poId && !result.poId && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link className="btn btn-sm btn-quiet" href={`/orders/${ev.poId}`}>
            {t('openPo')} {ev.number}
          </Link>
          {task.kind === 'supplier_reply' && ev.via === 'link' && <span className="faint" style={{ fontSize: 12 }}>{t('viaLink')}</span>}
        </div>
      )}

      {!open && result.sentDirect && <div className="notice notice-info">{t('sentDirect')}</div>}

      {!open && result.poId && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <Link className="btn btn-sm btn-primary" href={`/orders/${result.poId}`}>
            {t('openPo')} {result.number}
          </Link>
          {result.status === 'pending_approval' && <span className="tag tag-late">{t('needsApproval')}</span>}
        </div>
      )}

      {contact && (
        <div>
          <button className="link-btn" onClick={() => setShowMessage(!showMessage)} aria-expanded={showMessage}>
            {t('messageDraft')}
          </button>
          {showMessage && <blockquote className="message-draft">{ar ? contact.params.messageAr : contact.params.message}</blockquote>}
        </div>
      )}

      {!open && (result.mailto || result.whatsapp) && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {result.mailto && (
            <a className="btn btn-sm btn-quiet" href={result.mailto} target="_blank" rel="noopener noreferrer">
              {t('openEmail')}
            </a>
          )}
          {result.whatsapp && (
            <a className="btn btn-sm btn-quiet" href={result.whatsapp} target="_blank" rel="noopener noreferrer">
              {t('openWhatsapp')}
            </a>
          )}
        </div>
      )}
      {result.automatic && <div className="notice">{t('autoDone')}</div>}
      {open && result.autoBlocked && (
        <div className="notice">
          {t('autoBlocked')}: {result.autoBlocked}
        </div>
      )}
      {task.status === 'failed' && task.error && <div className="notice notice-error">{task.error}</div>}
      {task.decisionNote && <div className="notice">“{task.decisionNote}”</div>}
      {error && <div className="notice notice-error">{error}</div>}

      {open && canDecide && (
        <footer className="task-actions">
          {task.actions.map((a, i) =>
            a.autonomy === 'suggest' ? (
              <span key={a.id} className="tag" title={t('suggestOnly')}>
                {ar ? a.labelAr : a.label}
              </span>
            ) : (
              <button
                key={a.id}
                className={`btn btn-sm ${i === 0 ? 'btn-primary' : 'btn-quiet'}`}
                disabled={!!busy || task.agent.status !== 'active'}
                onClick={() => approve(a)}
                title={t('approveHint')}
              >
                {ar ? a.labelAr : a.label}
              </button>
            ),
          )}
          <span style={{ flex: 1 }} />
          {/* Nothing to approve (e.g. a supplier's message): only "done with it". */}
          {task.actions.length > 0 && (
            <button className="btn btn-sm btn-danger" disabled={!!busy} onClick={() => setRejecting(true)}>
              {t('reject')}
            </button>
          )}
          <button
            className={`btn btn-sm ${task.actions.length ? 'btn-quiet' : 'btn-primary'}`}
            disabled={!!busy}
            onClick={async () => {
              await api(`/agent-tasks/${task.id}/dismiss`, { method: 'POST', body: {} });
              onChanged();
            }}
          >
            {task.actions.length ? t('dismiss') : t('markHandled')}
          </button>
        </footer>
      )}
      <div className="faint" style={{ fontSize: 11 }}>
        {task.writtenBy === 'claude' ? t('writtenByClaude') : t('writtenByTemplate')}
      </div>

      {rejecting && (
        <RejectDialog
          onClose={() => setRejecting(false)}
          onReject={async (reason) => {
            await api(`/agent-tasks/${task.id}/reject`, { method: 'POST', body: { reason: reason || null } });
            setRejecting(false);
            onChanged();
          }}
        />
      )}
    </article>
  );
}

function RejectDialog({ onClose, onReject }: { onClose: () => void; onReject: (reason: string) => Promise<void> }) {
  const { t } = useI18n();
  const [reason, setReason] = useState('');
  return (
    <Dialog
      title={t('reject')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="btn btn-primary" onClick={() => onReject(reason)}>
            {t('reject')}
          </button>
        </>
      }
    >
      <Field label={t('rejectReason')} hint={t('optional')}>
        <textarea className="input" style={{ minHeight: 90, padding: 12 }} value={reason} onChange={(e) => setReason(e.target.value)} />
      </Field>
    </Dialog>
  );
}

/** Tiny price trend line (no axes; the numbers are shown next to it). */
function Spark({ values }: { values: number[] }) {
  const w = 120;
  const h = 36;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * (w - 4) + 2},${h - 2 - ((v - min) / span) * (h - 4)}`).join(' ');
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true" className="flip-rtl" style={{ flex: 'none' }}>
      <polyline points={pts} fill="none" stroke="var(--late)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
