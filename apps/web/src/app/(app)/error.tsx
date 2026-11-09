'use client';

import Link from 'next/link';
import { useEffect } from 'react';
import { useI18n } from '@/lib/i18n';
import { reportError } from '@/lib/report-error';

/** Shown when a page crashes while rendering; the shell around it keeps working. */
export default function PageError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const { t } = useI18n();
  useEffect(() => {
    reportError(error, 'render', error.digest);
  }, [error]);
  return (
    <div className="page">
      <section className="card" role="alert" style={{ gap: 12, maxWidth: 560 }}>
        <div className="card-title">{t('error')}</div>
        <div className="muted">{t('errorBody')}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={reset}>
            {t('tryAgain')}
          </button>
          <Link href="/inbox" className="btn btn-quiet">
            {t('backToInbox')}
          </Link>
        </div>
      </section>
    </div>
  );
}
