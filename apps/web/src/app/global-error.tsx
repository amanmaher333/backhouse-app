'use client';

import { useEffect } from 'react';
import { reportError } from '@/lib/report-error';

/** Last resort when the root layout itself fails: no providers or styles, so plain bilingual text. */
export default function GlobalError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    reportError(error, 'render', error.digest);
  }, [error]);
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', padding: 24, display: 'grid', gap: 12, maxWidth: 560 }}>
        <h1 style={{ fontSize: 20, margin: 0 }}>Something went wrong</h1>
        <p dir="rtl" lang="ar" style={{ margin: 0 }}>
          حدث خطأ ما
        </p>
        <p style={{ margin: 0, color: '#555' }}>We’ve been told about it. / تم إبلاغنا بالمشكلة.</p>
        <button onClick={reset} style={{ justifySelf: 'start', padding: '8px 14px' }}>
          Try again / حاول مرة أخرى
        </button>
      </body>
    </html>
  );
}
