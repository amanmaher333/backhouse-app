'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ArmButton, Dialog, Empty, Field, PageHead, Toast } from '@/components/ui';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { SavingsReport } from '@/lib/types-savings';
import { BankDetails } from '@/components/bank-details';
import { daysLabel } from '@/components/shell';

interface BillLine {
  code: string;
  description: string;
  descriptionAr: string;
  quantity: number;
  unitPrice: string;
  amount: string;
}
interface Bill {
  lines: BillLine[];
  subtotal: string;
  vat: string;
  total: string;
}
interface BillingOverview {
  /** Prices agreed with this organisation, while they apply. */
  pricing: { label: string; labelAr?: string | null; discountPct?: number | null; until?: string | null } | null;
  plan: string;
  status: string;
  entitled: boolean;
  interval: 'month' | 'year' | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  failedAttempts: number;
  nextRetryAt: string | null;
  paymentMethod: { brand: string; last4: string; expMonth?: number; expYear?: number } | null;
  /** 'bank_transfer' when agreed with Kitchain: no card, invoices wait for a transfer. */
  paymentMode: 'card' | 'bank_transfer';
  bank: { bankName: string | null; accountName: string; iban: string } | null;
  estimates: { month: Bill; year: Bill };
  invoices: { id: string; number: string; status: string; total: string; issuedAt: string; periodStart: string; periodEnd: string; failureMessage: string | null; dueAt: string | null }[];
  provider: 'simulated' | 'moyasar';
  actionUrl?: string | null;
}

const tpl = (s: string, v: Record<string, string | number>) => s.replace(/\{(\w+)\}/g, (_, k) => String(v[k] ?? ''));

function SubTag({ status }: { status: string }) {
  const { t } = useI18n();
  const cls = status === 'active' || status === 'free' ? 'tag-accent' : status === 'trialing' ? '' : 'tag-late';
  return <span className={`tag ${cls}`}>{t(`sub_${status}` as TKey)}</span>;
}

export default function BillingPage() {
  const { t, lang, fmtMoney, fmtDate } = useI18n();
  const { api, can } = useSession();
  const { data: b, reload, error } = useApi<BillingOverview>('/billing');
  const [interval, setInterval] = useState<'month' | 'year'>('month');
  const [addingCard, setAddingCard] = useState(false);
  const [bankCheck, setBankCheck] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const manage = can('billing:manage');
  const ar = lang === 'ar';

  useEffect(() => {
    if (b?.interval) setInterval(b.interval);
  }, [b?.interval]);

  if (error) return <div className="notice notice-error">{error.message}</div>;
  if (!b) return <div className="muted">{t('loading')}</div>;

  const run = async (fn: () => Promise<BillingOverview>, done?: string) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r.actionUrl) {
        if (b.provider === 'simulated') setBankCheck(new URL(r.actionUrl).searchParams.get('sim_payment'));
        else window.location.href = r.actionUrl;
      } else if (done) setToast(done);
      reload();
    } catch (e) {
      setToast((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const est = b.estimates[interval];
  const daysLeft = b.trialEndsAt ? Math.max(0, Math.ceil((new Date(b.trialEndsAt).getTime() - Date.now()) / 86400_000)) : null;
  const paying = ['active', 'past_due'].includes(b.status);
  const failedInvoice = b.invoices.find((i) => i.status === 'failed');
  // A card is needed only when paying by card and the plan costs something (agreed pricing can make it free).
  const cardNeeded = b.paymentMode !== 'bank_transfer' && Number(b.estimates[interval].total) > 0;

  return (
    <div className="page">
      <PageHead title={t('billing')} sub={t('billingSub')} />

      {!b.entitled && <div className="notice notice-error">{t('readOnlyNotice')}</div>}
      {b.status === 'past_due' && b.nextRetryAt && <div className="notice notice-error">{tpl(t('pastDueNotice'), { date: fmtDate(b.nextRetryAt) })}</div>}
      {b.status === 'trialing' && can('price:read') && <TrialValue />}

      <section className="card">
        <div className="card-head">
          <h2 className="card-title">{t('currentPlan')}</h2>
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
            {b.pricing && (
              <span className="tag tag-accent">
                {tpl(t('agreedPricingBadge'), { label: (lang === 'ar' && b.pricing.labelAr) || b.pricing.label })}
                {b.pricing.until ? ` · ${tpl(t('agreedUntil'), { date: fmtDate(b.pricing.until) })}` : ''}
              </span>
            )}
            <SubTag status={b.status} />
          </span>
        </div>
        <div className="billing-summary">
          {b.status === 'trialing' && daysLeft !== null && (
            <div>
              <div className="stat-value">{daysLeft === 0 ? t('trialEndsToday') : tpl(t('trialEndsIn'), { n: daysLabel(daysLeft, lang) })}</div>
              {b.interval && b.trialEndsAt && (
                <div className="faint" style={{ fontSize: 13 }}>
                  {t('willStartOn')} {fmtDate(b.trialEndsAt)} · {t(b.interval === 'year' ? 'annual' : 'monthly')}
                </div>
              )}
            </div>
          )}
          {paying && b.currentPeriodEnd && (
            <div>
              <div className="stat-value num">{fmtMoney(b.estimates[b.interval ?? 'month'].total, 2, 'SAR')}</div>
              <div className="faint" style={{ fontSize: 13 }}>
                {t(b.interval === 'year' ? 'annual' : 'monthly')} · {b.cancelAtPeriodEnd ? t('endsOn') : t('renewsOn')} {fmtDate(b.currentPeriodEnd)}
              </div>
            </div>
          )}
          {manage && (paying || (b.status === 'trialing' && b.interval)) && (
            <div style={{ marginInlineStart: 'auto' }}>
              {b.cancelAtPeriodEnd ? (
                <button className="btn btn-quiet" disabled={busy} onClick={() => run(() => api('/billing/resume', { method: 'POST' }))}>
                  {t('resumePlan')}
                </button>
              ) : (
                <ArmButton label={t('cancelPlan')} small={false} onConfirm={() => run(() => api('/billing/cancel', { method: 'POST' }))} />
              )}
            </div>
          )}
        </div>
        {b.cancelAtPeriodEnd && b.currentPeriodEnd && <div className="notice">{tpl(t('cancelNotice'), { date: fmtDate(b.currentPeriodEnd) })}</div>}
      </section>

      {b.plan === 'restaurant' && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('choosePlan')}</h2>
            <div className="segmented" role="group">
              <button aria-pressed={interval === 'month'} onClick={() => setInterval('month')}>
                {t('monthly')}
              </button>
              <button aria-pressed={interval === 'year'} onClick={() => setInterval('year')}>
                {t('annual')} <span className="tag tag-accent" style={{ marginInlineStart: 6 }}>{t('annualSave')}</span>
              </button>
            </div>
          </div>
          <div className="table-wrap">
            <table className="table">
              <tbody>
                {est.lines.map((l) => (
                  <tr key={l.code}>
                    <td>{ar ? l.descriptionAr : l.description}</td>
                    <td className="end num">{fmtMoney(l.amount, 2, 'SAR')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="totals">
            <span className="muted">{t('subtotal')}</span>
            <span className="num">{fmtMoney(est.subtotal, 2, 'SAR')}</span>
            <span className="muted">{t('vat')}</span>
            <span className="num">{fmtMoney(est.vat, 2, 'SAR')}</span>
            <strong>
              {t('total')} <span className="faint" style={{ fontWeight: 400 }}>{t(interval === 'year' ? 'perYear' : 'perMonth')}</span>
            </strong>
            <strong className="num">{fmtMoney(est.total, 2, 'SAR')}</strong>
          </div>
          <p className="faint" style={{ fontSize: 13, margin: 0 }}>
            {t('estimateNote')}
          </p>
          {manage && (
            <div>
              <button
                className="btn btn-primary"
                disabled={busy || (cardNeeded && !b.paymentMethod) || (b.interval === interval && b.status !== 'expired' && b.status !== 'canceled' && b.status !== 'suspended')}
                title={cardNeeded && !b.paymentMethod ? t('noCard') : undefined}
                onClick={() => run(() => api('/billing/subscribe', { method: 'POST', body: { interval } }), b.status === 'trialing' ? t('planChosenTrial') : t('paymentDone'))}
              >
                {b.interval && b.interval !== interval ? t('switchPlan') : t('startPlan')}
              </button>
            </div>
          )}
        </section>
      )}

      {b.plan === 'restaurant' && b.paymentMode === 'bank_transfer' && (
        <section className="card" style={{ gap: 10 }}>
          <h2 className="card-title">{t('payByTransfer')}</h2>
          <p className="muted" style={{ margin: 0 }}>{t('payByTransferBody')}</p>
          <BankDetails bank={b.bank} />
        </section>
      )}

      {b.plan === 'restaurant' && b.paymentMode !== 'bank_transfer' && (
        <section className="card">
          <div className="card-head">
            <h2 className="card-title">{t('card')}</h2>
            {manage && (
              <button className="btn btn-sm btn-quiet" onClick={() => setAddingCard(true)}>
                {b.paymentMethod ? t('replaceCard') : t('addCard')}
              </button>
            )}
          </div>
          {b.paymentMethod ? (
            <div className="card-chip">
              <span className="card-brand">{b.paymentMethod.brand.toUpperCase()}</span>
              <span className="num" dir="ltr">•••• {b.paymentMethod.last4}</span>
              {b.paymentMethod.expMonth && (
                <span className="faint num" dir="ltr">
                  {String(b.paymentMethod.expMonth).padStart(2, '0')}/{String(b.paymentMethod.expYear).slice(-2)}
                </span>
              )}
            </div>
          ) : (
            <p className="muted" style={{ margin: 0 }}>
              {t('noCard')}
            </p>
          )}
          {manage && failedInvoice && (
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api('/billing/pay-now', { method: 'POST' }), t('paymentDone'))}>
                {t('payNow')} · {fmtMoney(failedInvoice.total, 2, 'SAR')}
              </button>
              {failedInvoice.failureMessage && <span className="faint" style={{ fontSize: 13 }}>{failedInvoice.failureMessage}</span>}
            </div>
          )}
        </section>
      )}

      <section className="card">
        <h2 className="card-title">{t('invoices')}</h2>
        {b.invoices.length === 0 ? (
          <Empty title={t('noInvoices')} />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('invoice')}</th>
                  <th className="hide-phone">{t('period')}</th>
                  <th className="end">{t('total')}</th>
                  <th>{t('status')}</th>
                  <th className="end" />
                </tr>
              </thead>
              <tbody>
                {b.invoices.map((i) => (
                  <tr key={i.id}>
                    <td className="num">{i.number}</td>
                    <td className="hide-phone">
                      {fmtDate(i.periodStart)} – {fmtDate(i.periodEnd)}
                    </td>
                    <td className="end num">{fmtMoney(i.total, 2, 'SAR')}</td>
                    <td>
                      <span className={`tag ${i.status === 'paid' ? 'tag-accent' : i.status === 'failed' ? 'tag-late' : ''}`}>{t(`inv_${i.status}` as TKey)}</span>
                      {i.status === 'awaiting_transfer' && i.dueAt && <div className="faint num" style={{ fontSize: 12, marginTop: 4 }}>{tpl(t('dueOn'), { date: fmtDate(i.dueAt) })}</div>}
                    </td>
                    <td className="end">
                      <Link className="btn btn-sm btn-quiet" href={`/billing/invoices/${i.id}`}>
                        {t('view')}
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {addingCard && (
        <CardDialog
          provider={b.provider}
          onClose={() => setAddingCard(false)}
          onSaved={() => {
            setAddingCard(false);
            setToast(t('saved'));
            reload();
          }}
        />
      )}
      {bankCheck && (
        <Dialog
          title={t('bankCheck')}
          onClose={() => setBankCheck(null)}
          actions={
            <>
              <button
                className="btn btn-quiet"
                onClick={async () => {
                  await api(`/billing/simulate/${bankCheck}`, { method: 'POST', body: { outcome: 'failed' } });
                  setBankCheck(null);
                  reload();
                }}
              >
                {t('bankDecline')}
              </button>
              <button
                className="btn btn-primary"
                onClick={async () => {
                  await api(`/billing/simulate/${bankCheck}`, { method: 'POST', body: { outcome: 'paid' } });
                  setBankCheck(null);
                  setToast(t('paymentDone'));
                  reload();
                }}
              >
                {t('bankApprove')}
              </button>
            </>
          }
        >
          <p className="muted">{t('bankCheckBody')}</p>
        </Dialog>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/** Test-mode card form: turns test card numbers into simulator tokens. Real cards go through the provider's hosted form. */
function CardDialog({ provider, onClose, onSaved }: { provider: 'simulated' | 'moyasar'; onClose: () => void; onSaved: () => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [f, setF] = useState({ name: '', number: '', expiry: '', cvc: '' });
  const [error, setError] = useState<string | null>(null);
  const digits = f.number.replace(/\D/g, '');
  const valid = digits.length >= 15 && /^\d{2}\/\d{2}$/.test(f.expiry) && /^\d{3,4}$/.test(f.cvc);
  const token = () => {
    const brand = /^(4405|5297|5888|4847|9682|4685|5043)/.test(digits) ? 'mada' : digits.startsWith('4') ? 'visa' : digits.startsWith('3') ? 'amex' : 'mastercard';
    const suffix = digits.endsWith('0002') ? '_decline' : digits.endsWith('3220') ? '_3ds' : '';
    return `tok_sim_${brand}_${digits.slice(-4)}${suffix}`;
  };
  return (
    <Dialog
      title={t('addCard')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={provider !== 'simulated' || !valid}
            onClick={async () => {
              try {
                await api('/billing/payment-method', { method: 'POST', body: { token: token() } });
                onSaved();
              } catch (e) {
                setError((e as ApiError).message);
              }
            }}
          >
            {t('saveCard')}
          </button>
        </>
      }
    >
      <div className={`notice ${provider === 'simulated' ? 'notice-info' : ''}`}>{provider === 'simulated' ? t('simulatedPayments') : t('moyasarPending')}</div>
      {error && <div className="notice notice-error">{error}</div>}
      <Field label={t('nameOnCard')}>
        <input className="input" autoComplete="cc-name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
      </Field>
      <Field label={t('cardNumber')}>
        <input className="input num" dir="ltr" inputMode="numeric" autoComplete="cc-number" placeholder="4242 4242 4242 4242" value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
      </Field>
      <div className="form-row">
        <Field label={t('expiry')}>
          <input className="input num" dir="ltr" inputMode="numeric" autoComplete="cc-exp" placeholder="12/30" value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} />
        </Field>
        <Field label={t('cvc')}>
          <input className="input num" dir="ltr" inputMode="numeric" autoComplete="cc-csc" placeholder="123" value={f.cvc} onChange={(e) => setF({ ...f, cvc: e.target.value })} />
        </Field>
      </div>
    </Dialog>
  );
}

/** During the trial: what Kitchain has saved so far, against the monthly price (from the Savings report). */
function TrialValue() {
  const { t, fmtMoney, fmtDate } = useI18n();
  const { data: r } = useApi<SavingsReport>('/savings');
  if (!r?.trial) return null;
  const tr = r.trial;
  const money = (v: string) => fmtMoney(v, 2, r.currency);
  return (
    <section className="card savings-trial" style={{ gap: 6 }}>
      <div className="card-title" style={{ fontSize: 15 }}>{t('trialTitle')}</div>
      <div>
        {tpl(t('trialBody'), { date: fmtDate(tr.startedOn), saved: money(tr.saved), price: money(tr.monthlyPrice) })}{' '}
        {tr.multiple !== null && tr.multiple >= 1 && <strong>{tpl(t('trialMultiple'), { n: String(tr.multiple) })}</strong>}
      </div>
      <Link href="/savings" className="link-btn" style={{ justifySelf: 'start' }}>
        {t('savings')} →
      </Link>
    </section>
  );
}

