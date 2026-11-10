'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useMemo, useState } from 'react';
import { Empty, PageHead } from '@/components/ui';
import { useI18n, type TKey } from '@/lib/i18n';
import { useApi } from '@/lib/session';
import type { SavingKind, SavingRow, SavingsReport } from '@/lib/types-savings';

type Preset = 'month' | 'last' | '3m' | 'all' | 'link';
const KINDS: SavingKind[] = ['credit_note', 'duplicate', 'supplier_switch'];

/** First and last day of the month containing `date` (YYYY-MM-DD), shifted by `offset` months. */
function month(date: string, offset = 0) {
  const [y, m] = date.split('-').map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1 + offset, 1));
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0));
  return { from: first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) };
}

export default function SavingsPage() {
  return (
    <Suspense>
      <Savings />
    </Suspense>
  );
}

const isDate = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

function Savings() {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  // The monthly WhatsApp report links here with the month it covers.
  const params = useSearchParams();
  const linkFrom = params.get('from');
  const linkTo = params.get('to');
  const linked = isDate(linkFrom) && isDate(linkTo) ? { from: linkFrom, to: linkTo } : null;
  const [preset, setPreset] = useState<Preset>(linked ? 'link' : 'month');
  const [today, setToday] = useState(() => new Date().toISOString().slice(0, 10));
  const query = useMemo(() => {
    if (preset === 'link' && linked) return `?from=${linked.from}&to=${linked.to}`;
    if (preset === 'month') return '';
    if (preset === 'last') { const p = month(today, -1); return `?from=${p.from}&to=${p.to}`; }
    if (preset === '3m') return `?from=${month(today, -2).from}&to=${today}`;
    return `?from=2020-01-01&to=${today}`;
  }, [preset, today, linked?.from, linked?.to]);
  const { data: r, error } = useApi<SavingsReport>(`/savings${query}`, [query]);
  if (r && r.today !== today) setToday(r.today);
  const money = (v: string | null | undefined) => fmtMoney(v ?? '0', 2, r?.currency);
  const fill = (key: TKey, vars: Record<string, string | number>) => Object.entries(vars).reduce((s, [k, v]) => s.replace(`{${k}}`, String(v)), t(key) as string);

  const saved = r ? r.entries.filter((e) => e.kind !== 'claim_open') : [];
  const open = r ? r.entries.filter((e) => e.kind === 'claim_open') : [];
  const hasCost = r && Number(r.totals.cost) > 0;

  return (
    <div className="page">
      <PageHead title={t('savings')} sub={t('savingsSub')} />
      <div className="filters">
        <div className="segmented" role="group" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {(['month', 'last', '3m', 'all'] as Preset[]).map((p) => (
            <button key={p} aria-pressed={preset === p} onClick={() => setPreset(p)}>
              {t(p === 'month' ? 'periodThisMonth' : p === 'last' ? 'periodLastMonth' : p === '3m' ? 'period3Months' : 'periodAllTime')}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="notice notice-error">{error.message}</div>}

      {r && (
        <>
          {preset !== 'all' && (
            <div className="faint num" style={{ fontSize: 13 }}>
              {fmtDate(r.period.from)} – {fmtDate(r.period.to)}
            </div>
          )}

          {r.trial && (
            <section className="card savings-trial" style={{ gap: 6 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <div className="card-title" style={{ fontSize: 15 }}>{t('trialTitle')}</div>
                <span className="faint" style={{ fontSize: 13 }}>{r.trial.daysLeft > 0 ? fill('trialDaysLeft', { n: r.trial.daysLeft }) : t('trialLastDay')}</span>
              </div>
              <div>
                {fill('trialBody', {
                  date: fmtDate(r.trial.startedOn),
                  saved: money(r.trial.saved),
                  price: money(r.trial.monthlyPrice),
                })}{' '}
                {r.trial.multiple !== null && r.trial.multiple >= 1 && <strong>{fill('trialMultiple', { n: r.trial.multiple })}</strong>}
              </div>
            </section>
          )}

          <div className="stats">
            <div className="stat">
              <div className="stat-label">{t('savedLabel')}</div>
              <div className="stat-value savings-total">{money(r.totals.saved)}</div>
              {hasCost && r.totals.multiple !== null && r.totals.multiple >= 1 && <div className="faint num" style={{ fontSize: 12 }}>{fill('timesCost', { n: r.totals.multiple })}</div>}
            </div>
            <div className="stat">
              <div className="stat-label">{t('inProgress')}</div>
              <div className="stat-value" style={{ fontSize: 22 }}>{money(r.totals.inProgress)}</div>
              <div className="faint" style={{ fontSize: 12 }}>{t('inProgressHint')}</div>
            </div>
            {hasCost ? (
              <div className="stat">
                <div className="stat-label">{t('costOfKitchain')}</div>
                <div className="stat-value" style={{ fontSize: 22 }}>{money(r.totals.cost)}</div>
              </div>
            ) : (
              r.totals.planMonthly && (
                <div className="stat">
                  <div className="stat-label">{t('yourPlan')}</div>
                  <div className="stat-value" style={{ fontSize: 22 }}>{money(r.totals.planMonthly)}</div>
                  <div className="faint" style={{ fontSize: 12 }}>{t('savingsPerMonth')}</div>
                </div>
              )
            )}
          </div>

          <section className="card" style={{ gap: 10 }}>
            {KINDS.map((k) => (
              <div key={k} className="savings-kind">
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>
                    {t(`kind_${k}` as TKey)} {r.totals.byKind[k].count > 0 && <span className="faint num">× {r.totals.byKind[k].count}</span>}
                  </div>
                  <div className="faint" style={{ fontSize: 13 }}>{t(`kind_${k}_hint` as TKey)}</div>
                </div>
                <div className="num" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{money(r.totals.byKind[k].amount)}</div>
              </div>
            ))}
          </section>

          {saved.length === 0 ? (
            <div className="card">
              <Empty title={t('noSavingsTitle')} body={t('noSavingsBody')} action={<Link href="/agents" className="link-btn">{t('agents')}</Link>} />
            </div>
          ) : (
            <section className="card" style={{ gap: 4 }}>
              <div className="card-title" style={{ fontSize: 15 }}>{t('savingsEntries')}</div>
              {saved.map((e, i) => <Entry key={i} e={e} money={money} fill={fill} />)}
            </section>
          )}

          {open.length > 0 && (
            <section className="card" style={{ gap: 4 }}>
              <div className="card-title" style={{ fontSize: 15 }}>{t('openClaims')}</div>
              {open.map((e, i) => <Entry key={i} e={e} money={money} fill={fill} />)}
            </section>
          )}

          <details className="faint" style={{ fontSize: 13 }}>
            <summary style={{ cursor: 'pointer' }}>{t('howCounted')}</summary>
            <p style={{ margin: '6px 0 0' }}>{t('howCountedBody')}</p>
          </details>
        </>
      )}
    </div>
  );

  function Entry({ e, money, fill }: { e: SavingRow; money: (v: string) => string; fill: (k: TKey, v: Record<string, string | number>) => string }) {
    const href = e.subject.type === 'invoice' ? `/invoices/${e.subject.id}` : `/items/${e.subject.id}`;
    const label = e.subject.type === 'item' ? pick({ name: e.subject.label, nameAr: e.subject.labelAr }) : e.subject.label;
    const extra =
      e.kind === 'credit_note' && e.detail?.creditNote
        ? fill('creditNoteRef', { ref: e.detail.creditNote })
        : e.kind === 'claim_open' && e.detail?.claim
          ? fill('claimOf', { amount: money(e.detail.claim) })
          : e.kind === 'supplier_switch' && e.detail?.spend
            ? `${fill('spentAt', { spend: money(e.detail.spend), pct: e.detail.savingPct ?? 0 })} · ${fill('switchedOn', { date: fmtDate(e.detail.switchedOn ?? e.date) })}`
            : '';
    return (
      <div className="savings-entry">
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14 }}>
            <Link href={href}>{label}</Link>
            {e.supplier && <span className="muted"> · {pick(e.supplier)}</span>}
          </div>
          <div className="faint" style={{ fontSize: 12 }}>
            {t(`kind_${e.kind}` as TKey)} · <span className="num">{fmtDate(e.date)}</span>
            {extra && <> · {extra}</>}
          </div>
        </div>
        <div className="num" style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{money(e.amount)}</div>
      </div>
    );
  }
}
