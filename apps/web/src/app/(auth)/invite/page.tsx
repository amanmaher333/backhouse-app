'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { AuthFrame } from '@/components/auth-frame';
import { Field } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { useSession } from '@/lib/session';

function InviteForm() {
  const { t } = useI18n();
  const { begin } = useSession();
  const router = useRouter();
  const token = useSearchParams().get('token') ?? '';
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <AuthFrame title={t('acceptInviteTitle')}>
      <form
        className="form-grid"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          const res = await fetch('/api/session/accept', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token, password, fullName: fullName || undefined }),
          });
          const data = await res.json().catch(() => null);
          setBusy(false);
          if (!res.ok) return setError(data?.message ?? t('error'));
          await begin(data);
          router.replace('/overview');
        }}
      >
        <div className="notice">{t('acceptInviteHint')}</div>
        {error && <div className="notice notice-error">{error}</div>}
        <Field label={t('fullName')}>
          <input className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" />
        </Field>
        <Field label={t('password')} hint={t('passwordHint')}>
          <input className="input" type="password" required minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} dir="ltr" />
        </Field>
        <button className="btn btn-primary btn-lg btn-block" disabled={busy || !token}>
          {t('acceptInvite')}
        </button>
      </form>
    </AuthFrame>
  );
}

export default function InvitePage() {
  return (
    <Suspense>
      <InviteForm />
    </Suspense>
  );
}
