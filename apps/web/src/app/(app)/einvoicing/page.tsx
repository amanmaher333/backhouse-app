'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Dialog, Empty, Field, PageHead, Toast } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { LegalEntity } from '@/lib/types';
import type { ZatcaUnit } from '@/lib/types-sales';

function UnitStatusTag({ status }: { status: ZatcaUnit['status'] }) {
  const { t } = useI18n();
  const tone = status === 'active' ? 'tag-accent' : status === 'failed' ? 'tag-late' : '';
  return (
    <span className={`tag ${tone}`}>
      <span className="dot" />
      {t(`unit_${status}` as TKey)}
    </span>
  );
}

export default function EinvoicingPage() {
  const { t, pick, fmtDate } = useI18n();
  const { can } = useSession();
  const { data, reload } = useApi<{ mode: 'live' | 'simulated'; units: ZatcaUnit[] }>('/zatca/units');
  const { data: entities } = useApi<LegalEntity[]>('/legal-entities');
  const [creating, setCreating] = useState(false);
  const [onboarding, setOnboarding] = useState<ZatcaUnit | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const manage = can('einvoice:manage');
  const entityName = (id: string) => {
    const e = entities?.find((x) => x.id === id);
    return e ? pick(e) : '';
  };

  return (
    <div className="page">
      <PageHead
        title={t('einvoicing')}
        sub={t('einvoicingSub')}
        action={
          manage && (
            <button className="btn btn-primary" onClick={() => setCreating(true)}>
              <IconPlus /> {t('registerUnit')}
            </button>
          )
        }
      />
      {data?.mode === 'simulated' && <div className="notice">{t('simulatedMode')}</div>}

      {data && data.units.length === 0 ? (
        <div className="card">
          <Empty title={t('noUnits')} body={t('noUnitsBody')} />
        </div>
      ) : (
        data?.units.map((u) => (
          <section key={u.id} className="card">
            <div className="card-head">
              <div>
                <h2 className="card-title" style={{ marginBottom: 2 }}>
                  {u.name}
                </h2>
                <div className="faint" style={{ fontSize: 13 }}>
                  {entityName(u.legalEntityId)} · {t(`env_${u.environment}` as TKey)} · {t(`kinds_${u.invoiceTypes}` as TKey)}
                </div>
              </div>
              <UnitStatusTag status={u.status} />
            </div>
            {u.status === 'active' && (
              <dl className="dl">
                <dt>{t('certSerial')}</dt>
                <dd className="num">
                  <bdi>{u.certSerial}</bdi>
                </dd>
                <dt>{t('certExpires')}</dt>
                <dd className="num">{u.certExpiresAt ? fmtDate(u.certExpiresAt) : '–'}</dd>
                <dt>{t('documentsSigned')}</dt>
                <dd className="num">{u.icv}</dd>
              </dl>
            )}
            {u.lastError && <div className="notice notice-error">{u.lastError}</div>}
            {u.checks && u.checks.length > 0 && (
              <div>
                <div className="muted" style={{ fontSize: 13, marginBottom: 6 }}>
                  {t('complianceChecks')}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {u.checks.map((c, i) => (
                    <span key={i} className={`tag ${['PASS', 'WARNING'].includes(c.status) ? 'tag-accent' : 'tag-late'}`} title={c.errors.map((e) => e.message).join('\n')}>
                      {t(`kind_${c.kind}` as TKey)} · {t(`docType_${c.type}` as TKey)} · {c.status}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {manage && (
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {['new', 'failed'].includes(u.status) && (
                  <button className="btn btn-primary" onClick={() => setOnboarding(u)}>
                    {t('onboard')}
                  </button>
                )}
              </div>
            )}
          </section>
        ))
      )}

      {creating && entities && (
        <CreateUnitDialog
          entities={entities}
          onClose={() => setCreating(false)}
          onDone={(u) => {
            setCreating(false);
            reload();
            setOnboarding(u);
          }}
        />
      )}
      {onboarding && (
        <OnboardDialog
          unit={onboarding}
          onClose={() => setOnboarding(null)}
          onDone={() => {
            setOnboarding(null);
            reload();
          }}
          onError={() => reload()}
        />
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function CreateUnitDialog({ entities, onClose, onDone }: { entities: LegalEntity[]; onClose: () => void; onDone: (u: ZatcaUnit) => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const [legalEntityId, setLegalEntityId] = useState(entities[0]?.id ?? '');
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState('simulation');
  const [invoiceTypes, setInvoiceTypes] = useState('1100');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={t('registerUnit')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || name.trim().length < 2 || !legalEntityId}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                onDone(await api<ZatcaUnit>('/zatca/units', { method: 'POST', body: { legalEntityId, name: name.trim(), environment, invoiceTypes } }));
              } catch (e) {
                setError((e as ApiError).message);
                setBusy(false);
              }
            }}
          >
            {t('registerUnit')}
          </button>
        </>
      }
    >
      {error && (
        <div className="notice notice-error">
          {error}
          {/company details/i.test(error) && (
            <>
              {' '}
              <Link href="/settings">{t('completeCompany')} →</Link>
            </>
          )}
        </div>
      )}
      <Field label={t('company')}>
        <select className="select" value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)}>
          {entities.map((e) => (
            <option key={e.id} value={e.id}>
              {pick(e)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('unitName')} hint={t('unitNameHint')}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </Field>
      <Field label={t('environment')}>
        <select className="select" value={environment} onChange={(e) => setEnvironment(e.target.value)}>
          {(['simulation', 'production', 'sandbox'] as const).map((x) => (
            <option key={x} value={x}>
              {t(`env_${x}`)}
            </option>
          ))}
        </select>
      </Field>
      <Field label={t('invoiceKinds')}>
        <select className="select" value={invoiceTypes} onChange={(e) => setInvoiceTypes(e.target.value)}>
          {(['1100', '1000', '0100'] as const).map((x) => (
            <option key={x} value={x}>
              {t(`kinds_${x}`)}
            </option>
          ))}
        </select>
      </Field>
    </Dialog>
  );
}

function OnboardDialog({ unit, onClose, onDone, onError }: { unit: ZatcaUnit; onClose: () => void; onDone: () => void; onError: () => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  const [otp, setOtp] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      title={`${t('onboard')}: ${unit.name}`}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={busy || !/^\d{6}$/.test(otp)}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await api(`/zatca/units/${unit.id}/onboard`, { method: 'POST', body: { otp } });
                onDone();
              } catch (e) {
                setError((e as ApiError).message);
                setBusy(false);
                onError();
              }
            }}
          >
            {busy ? t('onboarding') : t('onboard')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <Field label={t('otp')} hint={t('otpHint')}>
        <input className="input num" dir="ltr" inputMode="numeric" maxLength={6} value={otp} onChange={(e) => setOtp(e.target.value.replace(/\D/g, ''))} autoFocus style={{ letterSpacing: 4, fontSize: 18 }} />
      </Field>
    </Dialog>
  );
}
