'use client';

import { useState } from 'react';
import { Dialog, Empty, Field, PageHead, Toast } from '@/components/ui';
import { useI18n, type TKey } from '@/lib/i18n';
import { useApi, useSession } from '@/lib/session';

interface Pricing {
  label: string;
  labelAr?: string | null;
  platformFee?: string | null;
  agentFees?: Record<string, string> | null;
  discountPct?: number | null;
  until?: string | null;
  note?: string | null;
}
interface OrgRow {
  id: string;
  name: string;
  nameAr: string | null;
  status: string;
  interval: string | null;
  trialEndsAt: string | null;
  activeSites: number;
  agents: string[];
  pricing: Pricing | null;
  pricingActive: boolean;
  monthly: { list: string; agreed: string };
}

/** List prices (before VAT), mirrored from the billing rules, to show what an empty field means. */
const LIST = { platform: '400.00', agents: { price_watch: '150.00', purchasing: '350.00', invoice: '250.00', cost_controller: '250.00' } as Record<string, string> };
const AGENT_KINDS = ['price_watch', 'purchasing', 'invoice', 'cost_controller'];
const tpl = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

/** Kitchain staff only: agreed pricing per organisation and trial extensions. */
export default function PlatformPage() {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const [q, setQ] = useState('');
  const { data, error, reload } = useApi<OrgRow[]>(`/platform/organizations${q ? `?q=${encodeURIComponent(q)}` : ''}`, [q]);
  const [pricingFor, setPricingFor] = useState<OrgRow | null>(null);
  const [trialFor, setTrialFor] = useState<OrgRow | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  return (
    <div className="page">
      <PageHead title={t('platform')} sub={t('platformSub')} />
      <div className="filters">
        <input className="input" style={{ flex: '1 1 260px', maxWidth: 420 }} placeholder={t('searchOrgs')} aria-label={t('searchOrgs')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {error && <div className="notice notice-error">{error.message}</div>}
      {data && data.length === 0 && (
        <div className="card">
          <Empty title={t('searchOrgs')} />
        </div>
      )}
      {data && data.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('colOrg')}</th>
                <th>{t('colStatus')}</th>
                <th className="end">{t('colMonthly')}</th>
                <th>{t('colPricing')}</th>
              </tr>
            </thead>
            <tbody>
              {data.map((o) => (
                <tr key={o.id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{pick(o)}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      {tpl(t('sitesAgents'), { sites: o.activeSites, agents: o.agents.length })}
                    </div>
                  </td>
                  <td>
                    <span className="tag">{o.status}</span>
                    {o.status === 'trialing' && o.trialEndsAt && (
                      <div className="faint num" style={{ fontSize: 12, marginTop: 4 }}>
                        {fmtDate(o.trialEndsAt)}
                      </div>
                    )}
                  </td>
                  <td className="end num">
                    {o.monthly.agreed !== o.monthly.list ? (
                      <>
                        <div style={{ fontWeight: 600 }}>{fmtMoney(o.monthly.agreed, 2, 'SAR')}</div>
                        <div className="faint" style={{ fontSize: 12, textDecoration: 'line-through' }}>
                          {fmtMoney(o.monthly.list, 2, 'SAR')}
                        </div>
                      </>
                    ) : (
                      fmtMoney(o.monthly.list, 2, 'SAR')
                    )}
                  </td>
                  <td>
                    <div style={{ fontSize: 14 }}>
                      {o.pricing ? (
                        <>
                          {o.pricing.label}
                          {o.pricing.until && <span className="faint"> · {o.pricingActive ? tpl(t('agreedUntil'), { date: fmtDate(o.pricing.until) }) : t('pricingEnded')}</span>}
                        </>
                      ) : (
                        <span className="faint">{t('noCustomPricing')}</span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                      <button className="btn btn-sm btn-quiet" onClick={() => setPricingFor(o)}>
                        {t('editPricing')}
                      </button>
                      {['trialing', 'expired'].includes(o.status) && (
                        <button className="btn btn-sm btn-quiet" onClick={() => setTrialFor(o)}>
                          {t('extendTrial')}
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {pricingFor && (
        <PricingDialog
          org={pricingFor}
          onClose={() => setPricingFor(null)}
          onSaved={() => {
            setPricingFor(null);
            setToast(t('pricingSaved'));
            reload();
          }}
        />
      )}
      {trialFor && (
        <TrialDialog
          org={trialFor}
          onClose={() => setTrialFor(null)}
          onSaved={() => {
            setTrialFor(null);
            setToast(t('trialSaved'));
            reload();
          }}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function PricingDialog({ org, onClose, onSaved }: { org: OrgRow; onClose: () => void; onSaved: () => void }) {
  const { t, pick, fmtMoney } = useI18n();
  const { api } = useSession();
  const p = org.pricing;
  const [label, setLabel] = useState(p?.label ?? 'Design partner');
  const [labelAr, setLabelAr] = useState(p?.labelAr ?? 'شريك تصميم');
  const [platformFee, setPlatformFee] = useState(p?.platformFee ?? '');
  const [fees, setFees] = useState<Record<string, string>>(p?.agentFees ?? {});
  const [discount, setDiscount] = useState(p?.discountPct != null ? String(p.discountPct) : '');
  const [until, setUntil] = useState(p?.until ?? '');
  const [note, setNote] = useState(p?.note ?? '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async (pricing: Pricing | null) => {
    setBusy(true);
    setErr(null);
    try {
      await api(`/platform/organizations/${org.id}/pricing`, { method: 'PUT', body: { pricing } });
      onSaved();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const agentFees = Object.fromEntries(Object.entries(fees).filter(([, v]) => v !== ''));
  return (
    <Dialog
      title={`${t('editPricing')} · ${pick(org)}`}
      onClose={onClose}
      actions={
        <>
          {p && (
            <button className="btn btn-quiet" disabled={busy} onClick={() => save(null)}>
              {t('clearPricing')}
            </button>
          )}
          <button
            className="btn btn-primary"
            disabled={busy || !label.trim()}
            onClick={() =>
              save({
                label: label.trim(),
                labelAr: labelAr.trim() || null,
                platformFee: platformFee === '' ? null : platformFee,
                agentFees: Object.keys(agentFees).length ? agentFees : null,
                discountPct: discount === '' ? null : Number(discount),
                until: until || null,
                note: note.trim() || null,
              })
            }
          >
            {t('savePricing')}
          </button>
        </>
      }
    >
      <div className="form-grid" style={{ display: 'grid', gap: 12 }}>
        {err && <div className="notice notice-error">{err}</div>}
        <div className="form-row">
          <Field label={t('pricingLabel')}>
            <input className="input" value={label} onChange={(e) => setLabel(e.target.value)} maxLength={60} />
          </Field>
          <Field label={t('pricingLabelAr')}>
            <input className="input" dir="rtl" value={labelAr} onChange={(e) => setLabelAr(e.target.value)} maxLength={60} />
          </Field>
        </div>
        <Field label={t('platformFeeField')} hint={tpl(t('leaveEmptyForList'), { price: fmtMoney(LIST.platform, 2, 'SAR') })}>
          <input className="input num" inputMode="decimal" value={platformFee} onChange={(e) => setPlatformFee(e.target.value)} />
        </Field>
        <div className="form-row">
          {AGENT_KINDS.map((k) => (
            <Field key={k} label={tpl(t('agentFeeField'), { agent: t(`agent_${k}` as TKey) })} hint={tpl(t('leaveEmptyForList'), { price: fmtMoney(LIST.agents[k]!, 2, 'SAR') })}>
              <input className="input num" inputMode="decimal" value={fees[k] ?? ''} onChange={(e) => setFees({ ...fees, [k]: e.target.value })} />
            </Field>
          ))}
        </div>
        <div className="form-row">
          <Field label={t('discountField')}>
            <input className="input num" inputMode="decimal" value={discount} onChange={(e) => setDiscount(e.target.value)} />
          </Field>
          <Field label={t('untilField')}>
            <input className="input" type="date" value={until} onChange={(e) => setUntil(e.target.value)} />
          </Field>
        </div>
        <Field label={t('noteField')}>
          <textarea className="input" rows={2} value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
      </div>
    </Dialog>
  );
}

function TrialDialog({ org, onClose, onSaved }: { org: OrgRow; onClose: () => void; onSaved: () => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const [date, setDate] = useState(org.trialEndsAt ? org.trialEndsAt.slice(0, 10) : '');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={`${t('extendTrial')} · ${pick(org)}`}
      onClose={onClose}
      actions={
        <button
          className="btn btn-primary"
          disabled={busy || !date}
          onClick={async () => {
            setBusy(true);
            setErr(null);
            try {
              await api(`/platform/organizations/${org.id}/trial`, { method: 'POST', body: { trialEndsOn: date } });
              onSaved();
            } catch (e) {
              setErr((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('saveTrial')}
        </button>
      }
    >
      <div style={{ display: 'grid', gap: 12 }}>
        {err && <div className="notice notice-error">{err}</div>}
        <Field label={t('trialEndsOnField')} hint={t('trialOnlyWhen')}>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
      </div>
    </Dialog>
  );
}
