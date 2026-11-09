'use client';

import { useEffect, type ReactNode } from 'react';
import { I18nProvider, type Lang } from '@/lib/i18n';
import { SessionProvider } from '@/lib/session';
import { listenForErrors } from '@/lib/report-error';

export function Providers({ children, lang }: { children: ReactNode; lang: Lang }) {
  useEffect(() => listenForErrors(), []);
  useEffect(() => {
    if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);
  return (
    <I18nProvider initialLang={lang}>
      <SessionProvider>{children}</SessionProvider>
    </I18nProvider>
  );
}
