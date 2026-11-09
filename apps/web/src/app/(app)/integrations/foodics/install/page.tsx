'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { PageHead } from '@/components/ui';
import { useI18n } from '@/lib/i18n';
import { ApiError, useSession } from '@/lib/session';

/**
 * The Install URL Foodics opens from its Marketplace. Signing in happens first (the app shell
 * sends anonymous visitors to the login page and back), then we start the approval at Foodics.
 */
export default function FoodicsInstallPage() {
  const { t } = useI18n();
  const { api, status } = useSession();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);
  useEffect(() => {
    if (status !== 'authenticated' || started.current) return;
    started.current = true;
    api<{ url: string }>('/integrations/foodics/connect', { method: 'POST' })
      .then(({ url }) => {
        window.location.href = url;
      })
      .catch((e: ApiError) => (e.status === 409 ? router.replace('/integrations') : setError(e.message)));
  }, [status, api, router]);
  return (
    <div className="page">
      <PageHead title="Foodics" />
      <section className="card" style={{ gap: 12 }}>
        {error ? (
          <>
            <div className="notice notice-error">{error}</div>
            <Link className="btn btn-quiet" href="/integrations" style={{ justifySelf: 'start' }}>
              {t('backToIntegrations')}
            </Link>
          </>
        ) : (
          <div className="muted">{t('installing')}</div>
        )}
      </section>
    </div>
  );
}
