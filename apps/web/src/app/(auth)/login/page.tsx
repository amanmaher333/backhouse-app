'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Field } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

function LoginForm() {
  const { t } = useI18n();
  const { begin, status } = useSession();
  const router = useRouter();
  const next = useSearchParams().get('next') || '/overview';
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'authenticated') router.replace(next);
  }, [status, router, next]);

  return (
    <AuthFrame title={t('signInTitle')}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const res = await fetch('/api/session/login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email, password }),
          });
          const data = await res.json().catch(() => null);
          setBusy(false);
          if (!res.ok) return setError(data?.message ?? t('error'));
          await begin(data);
          router.replace(next);
        }}
      >
        {error && <div className="notice notice-error">{error}</div>}
        <Field label={t('email')}>
          <input className="input" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} dir="ltr" />
        </Field>
        <Field label={t('password')}>
          <input className="input" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
        </Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy}>
          {t('signIn')}
        </button>
        <p className="muted" style={{ margin: 0, textAlign: 'center' }}>
          {t('noAccount')} <Link href="/signup">{t('createAccount')}</Link>
        </p>
      </form>
    </AuthFrame>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}
