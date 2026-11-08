'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Field } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ApiError, useSession } from '@/lib/session';

export default function SignupPage() {
  const { t, lang } = useI18n();
  const { begin } = useSession();
  const router = useRouter();
  const [f, setF] = useState({
    fullName: '',
    email: '',
    phone: '',
    password: '',
    orgName: '',
    orgNameAr: '',
    type: 'restaurant_group',
    legalName: '',
    vatNumber: '',
    crNumber: '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });

  return (
    <AuthFrame title={t('createTitle')}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          setErrors({});
          const res = await fetch('/api/session/signup', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              email: f.email,
              password: f.password,
              fullName: f.fullName,
              phone: f.phone || undefined,
              locale: lang,
              organization: { name: f.orgName, nameAr: f.orgNameAr || undefined, type: f.type },
              legalEntity: {
                name: f.legalName || f.orgName,
                vatNumber: f.vatNumber || undefined,
                crNumber: f.crNumber || undefined,
              },
            }),
          });
          const data = await res.json().catch(() => null);
          setBusy(false);
          if (!res.ok) {
            setErrors(new ApiError(res.status, data).fieldErrors());
            return setError(data?.issues ? null : (data?.message ?? t('error')));
          }
          await begin(data);
          router.replace('/');
        }}
      >
        {error && <div className="notice notice-error">{error}</div>}
        <div className="form-row">
          <Field label={t('fullName')} error={errors.fullName}>
            <input className="input" required value={f.fullName} onChange={set('fullName')} autoComplete="name" />
          </Field>
          <Field label={t('phone')} error={errors.phone} hint="+9665XXXXXXXX">
            <input className="input" value={f.phone} onChange={set('phone')} inputMode="tel" dir="ltr" autoComplete="tel" />
          </Field>
        </div>
        <Field label={t('email')} error={errors.email}>
          <input className="input" type="email" required value={f.email} onChange={set('email')} dir="ltr" autoComplete="email" />
        </Field>
        <Field label={t('password')} hint={t('passwordHint')} error={errors.password}>
          <input className="input" type="password" required minLength={10} value={f.password} onChange={set('password')} dir="ltr" autoComplete="new-password" />
        </Field>
        <div className="form-row">
          <Field label={t('orgName')} error={errors['organization.name']}>
            <input className="input" required value={f.orgName} onChange={set('orgName')} />
          </Field>
          <Field label={t('orgNameAr')}>
            <input className="input" value={f.orgNameAr} onChange={set('orgNameAr')} dir="rtl" lang="ar" />
          </Field>
        </div>
        <Field label={t('orgType')}>
          <select className="select" value={f.type} onChange={set('type')}>
            <option value="restaurant_group">{t('restaurantGroup')}</option>
            <option value="supplier">{t('supplier')}</option>
          </select>
        </Field>
        <Field label={t('legalName')}>
          <input className="input" value={f.legalName} onChange={set('legalName')} placeholder={f.orgName} />
        </Field>
        <div className="form-row">
          <Field label={t('vatNumber')} hint={t('vatHint')} error={errors['legalEntity.vatNumber']}>
            <input className="input num" value={f.vatNumber} onChange={set('vatNumber')} inputMode="numeric" dir="ltr" maxLength={15} />
          </Field>
          <Field label={t('crNumber')} hint={t('crHint')} error={errors['legalEntity.crNumber']}>
            <input className="input num" value={f.crNumber} onChange={set('crNumber')} inputMode="numeric" dir="ltr" maxLength={10} />
          </Field>
        </div>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {t('createAccount')}
        </button>
        <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
          {t('haveAccount')} <Link href="/login">{t('signIn')}</Link>
        </p>
      </form>
    </AuthFrame>
  );
}
