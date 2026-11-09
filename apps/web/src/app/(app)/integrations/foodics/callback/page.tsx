'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';
import { PageHead } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ApiError, useSession } from '@/lib/session';

/** Foodics sends the owner back here with ?code&state after they approve Backhouse. */
function Callback() {
  const { t } = useI18n();
  const { api, status } = useSession();
  const params = useSearchParams();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (status !== 'authenticated' || started.current) return;
    started.current = true;
    const code = params.get('code');
    const state = params.get('state');
    if (!code || !state) {
      setError(t('callbackFailed'));
      return;
    }
    (async () => {
      try {
        await api('/integrations/foodics/callback', { method: 'POST', body: { code, state } });
        // First sync straight away, so branches and items are there when the page opens.
        await api('/integrations/foodics/sync', { method: 'POST' }).catch(() => undefined);
        router.replace('/integrations');
      } catch (e) {
        setError((e as ApiError).message);
      }
    })();
  }, [status, params, api, router, t]);
  return (
    <div className="page">
      <PageHead title="Foodics" />
      <section className="card" style={{ gap: 12 }}>
        {error ? (
          <>
            <div className="notice notice-error">
              <strong>{t('callbackFailed')}</strong>
              <div>{error}</div>
            </div>
            <Link className="btn btn-quiet" href="/integrations" style={{ justifySelf: 'start' }}>
              {t('backToIntegrations')}
            </Link>
          </>
        ) : (
          <div className="muted">{t('connectedOk')}</div>
        )}
      </section>
    </div>
  );
}

export default function FoodicsCallbackPage() {
  return (
    <Suspense>
      <Callback />
    </Suspense>
  );
}
