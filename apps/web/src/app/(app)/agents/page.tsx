'use client';

import { useEffect, useState } from 'react';
import { ArmButton, Dialog, PageHead, Toast, shortAgo } from '@/components/ui';
import { IconBot } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';

type Level = 'suggest' | 'approve' | 'auto';
interface ActionType {
  type: string;
  label: string;
  labelAr: string;
  allowed: Level[];
  default: Level;
}
interface CatalogEntry {
  kind: string;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  actionTypes: ActionType[];
  defaultSettings: Record<string, number | boolean | string>;
}
interface Installed {
  id: string;
  kind: string;
  name: string;
  nameAr: string | null;
  status: 'active' | 'paused';
  autonomy: Record<string, Level>;
  settings: Record<string, number | boolean | string>;
  lastRunAt: string | null;
  openTasks: number;
  last30CostUsd: number;
  executed30: number;
}
interface Run {
  id: number;
  trigger: string;
  status: string;
  eventsProcessed: number;
  tasksCreated: number;
  tasksUpdated: number;
  actionsExecuted: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: string;
  error: string | null;
  startedAt: string;
}

export default function AgentsPage() {
  const { t, lang } = useI18n();
  const { api, can } = useSession();
  const { data, reload } = useApi<{ installed: Installed[]; available: CatalogEntry[]; llm: 'claude' | 'template' }>('/agents');
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canManage = can('agent:manage');
  const ar = lang === 'ar';
  const hiredKinds = new Set(data?.installed.map((x) => x.kind));
  const catalogByKind = new Map(data?.available.map((c) => [c.kind, c]));

  return (
    <div className="page">
      <PageHead title={t('agents')} sub={t('agentsSub')} action={data && <span className="tag">{data.llm === 'claude' ? t('llmClaude') : t('llmTemplate')}</span>} />

      <div className="agent-grid">
        {data?.installed.map((ag) => (
          <AgentCard
            key={ag.id}
            agent={ag}
            def={catalogByKind.get(ag.kind)!}
            canManage={canManage}
            onChanged={(msg) => {
              if (msg) setToast(msg);
              reload();
            }}
          />
        ))}
        {data?.available
          .filter((c) => !hiredKinds.has(c.kind))
          .map((c) => (
            <section key={c.kind} className="card">
              <div className="card-head">
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span className="avatar">
                    <IconBot width={18} height={18} />
                  </span>
                  <h2 className="card-title">{ar ? c.nameAr : c.name}</h2>
                </div>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {ar ? c.descriptionAr : c.description}
              </p>
              {canManage && (
                <div>
                  <button
                    className="btn btn-primary"
                    disabled={busy}
                    onClick={async () => {
                      setBusy(true);
                      try {
                        const r = await api<{ firstRun: { tasksCreated: number } }>('/agents', { method: 'POST', body: { kind: c.kind } });
                        setToast(`${t('hired')} · ${t('tasksNew')}: ${r.firstRun.tasksCreated}`);
                        reload();
                      } catch (e) {
                        setToast((e as ApiError).message);
                      } finally {
                        setBusy(false);
                      }
                    }}
                  >
                    {t('hire')}
                  </button>
                </div>
              )}
            </section>
          ))}
      </div>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function AgentCard({ agent, def, canManage, onChanged }: { agent: Installed; def: CatalogEntry; canManage: boolean; onChanged: (msg?: string) => void }) {
  const { t, lang, fmtNum } = useI18n();
  const { api } = useSession();
  const [settings, setSettings] = useState(agent.settings);
  const [showRuns, setShowRuns] = useState(false);
  const [running, setRunning] = useState(false);
  const ar = lang === 'ar';
  useEffect(() => setSettings(agent.settings), [agent.settings]);
  const settingsDirty = JSON.stringify(settings) !== JSON.stringify(agent.settings);
  const patch = (body: Record<string, unknown>) =>
    api(`/agents/${agent.id}`, { method: 'PATCH', body })
      .then(() => onChanged(t('saved')))
      .catch((e: ApiError) => onChanged(e.message));

  return (
    <section className="card">
      <div className="card-head">
        <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
          <span className="avatar">
            <IconBot width={18} height={18} />
          </span>
          <div>
            <h2 className="card-title">{ar ? agent.nameAr ?? agent.name : agent.name}</h2>
            <div className="faint" style={{ fontSize: 12 }}>
              {agent.lastRunAt ? shortAgo(agent.lastRunAt, lang) : '–'}
            </div>
          </div>
        </div>
        <span className={`tag ${agent.status === 'active' ? 'tag-accent' : 'tag-late'}`}>
          <span className="dot" />
          {agent.status === 'active' ? t('activeAgent') : t('paused')}
        </span>
      </div>

      <div className="stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <div>
          <div className="stat-label">{t('openTasks')}</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 700 }}>
            {agent.openTasks}
          </div>
        </div>
        <div>
          <div className="stat-label">{t('executed30')}</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 700 }}>
            {agent.executed30}
          </div>
        </div>
        <div>
          <div className="stat-label">{t('cost30')}</div>
          <div className="num" style={{ fontSize: 20, fontWeight: 700 }} dir="ltr">
            ${fmtNum(agent.last30CostUsd, 2)}
          </div>
        </div>
      </div>

      <div className="field">
        <span>{t('autonomy')}</span>
        {def.actionTypes.map((at) => (
          <div key={at.type} className="setting-row">
            <span>{ar ? at.labelAr : at.label}</span>
            <div className="segmented" role="group" aria-label={ar ? at.labelAr : at.label}>
              {(['suggest', 'approve', 'auto'] as Level[]).map((lv) => (
                <button
                  key={lv}
                  type="button"
                  aria-pressed={agent.autonomy[at.type] === lv}
                  disabled={!canManage || !at.allowed.includes(lv)}
                  onClick={() => patch({ autonomy: { [at.type]: lv } })}
                >
                  {t(`au_${lv}` as TKey)}
                </button>
              ))}
            </div>
          </div>
        ))}
        <span className="field-hint">{t('auHelp')}</span>
      </div>

      <div className="field">
        <span>{t('limits')}</span>
        {Object.entries(def.defaultSettings)
          .filter(([, v]) => typeof v === 'number')
          .map(([k]) => (
            <div key={k} className="setting-row">
              <label htmlFor={`${agent.id}-${k}`}>{t(k as TKey)}</label>
              {k === 'weekEndsOn' ? (
                <select
                  id={`${agent.id}-${k}`}
                  className="select inline-input"
                  disabled={!canManage}
                  value={String(settings[k] ?? 6)}
                  onChange={(e) => setSettings({ ...settings, [k]: Number(e.target.value) })}
                >
                  {t('days')
                    .split(',')
                    .map((d, i) => (
                      <option key={i} value={i}>
                        {d}
                      </option>
                    ))}
                </select>
              ) : (
                <input
                  id={`${agent.id}-${k}`}
                  className="input inline-input num"
                  inputMode="numeric"
                  disabled={!canManage}
                  value={String(settings[k] ?? '')}
                  onChange={(e) => setSettings({ ...settings, [k]: e.target.value === '' ? '' : Number(e.target.value) })}
                />
              )}
            </div>
          ))}
        {canManage && settingsDirty && (
          <div>
            <button className="btn btn-sm btn-primary" onClick={() => patch({ settings })}>
              {t('save')}
            </button>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {canManage && (
          <button
            className="btn btn-sm btn-primary"
            disabled={running || agent.status !== 'active'}
            onClick={async () => {
              setRunning(true);
              try {
                const r = await api<{ tasksCreated: number; tasksUpdated: number }>(`/agents/${agent.id}/run`, { method: 'POST', body: { scan: true } });
                onChanged(`${t('ranResult')} · ${t('tasksNew')}: ${r.tasksCreated} · ${t('tasksUpd')}: ${r.tasksUpdated}`);
              } finally {
                setRunning(false);
              }
            }}
          >
            {t('runNow')}
          </button>
        )}
        {canManage && (
          <button className="btn btn-sm btn-quiet" onClick={() => patch({ status: agent.status === 'active' ? 'paused' : 'active' })}>
            {agent.status === 'active' ? t('pause') : t('resume')}
          </button>
        )}
        <button className="btn btn-sm btn-quiet" onClick={() => setShowRuns(true)}>
          {t('runs')}
        </button>
        <span style={{ flex: 1 }} />
        {canManage && (
          <ArmButton
            label={t('letGo')}
            onConfirm={async () => {
              await api(`/agents/${agent.id}`, { method: 'DELETE' });
              onChanged();
            }}
          />
        )}
      </div>
      {showRuns && <RunsDialog agentId={agent.id} onClose={() => setShowRuns(false)} />}
    </section>
  );
}

function RunsDialog({ agentId, onClose }: { agentId: string; onClose: () => void }) {
  const { t, lang } = useI18n();
  const { data } = useApi<Run[]>(`/agents/${agentId}/runs`, [agentId]);
  return (
    <Dialog title={t('runs')} onClose={onClose}>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{t('when')}</th>
              <th>{t('trigger')}</th>
              <th className="end">{t('eventsProcessed')}</th>
              <th className="end">{t('tasksNew')}</th>
              <th className="end">$</th>
            </tr>
          </thead>
          <tbody>
            {data?.map((r) => (
              <tr key={r.id}>
                <td className="num faint">{shortAgo(r.startedAt, lang)}</td>
                <td>
                  <span className={`tag ${r.status === 'failed' ? 'tag-late' : ''}`} title={r.error ?? undefined}>
                    {t(`tr_${r.trigger}` as TKey)}
                  </span>
                </td>
                <td className="end num">{r.eventsProcessed}</td>
                <td className="end num">
                  {r.tasksCreated}
                  {r.tasksUpdated ? ` / ~${r.tasksUpdated}` : ''}
                </td>
                <td className="end num" dir="ltr" title={r.model ? `${r.model} · ${r.inputTokens} in / ${r.outputTokens} out` : undefined}>
                  {Number(r.costUsd).toFixed(4)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Dialog>
  );
}
