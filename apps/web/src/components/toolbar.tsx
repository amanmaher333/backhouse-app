'use client';

import { useEffect, useState } from 'react';
import { useI18n } from '@/lib/i18n';
import { IconDownload, IconMoon, IconSun } from './icons';

export function ThemeButton() {
  const { t } = useI18n();
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  useEffect(() => setTheme((document.documentElement.dataset.theme as 'light' | 'dark') ?? 'light'), []);
  return (
    <button
      className="icon-btn"
      aria-label={t('theme')}
      title={t('theme')}
      onClick={() => {
        const next = theme === 'dark' ? 'light' : 'dark';
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem('boh.theme', next);
        } catch {}
        setTheme(next);
      }}
    >
      {theme === 'dark' ? <IconSun /> : <IconMoon />}
    </button>
  );
}

export function LangButton() {
  const { t, lang, setLang } = useI18n();
  return (
    <button className="lang-btn" onClick={() => setLang(lang === 'ar' ? 'en' : 'ar')} lang={lang === 'ar' ? 'en' : 'ar'}>
      {t('language')}
    </button>
  );
}

export function SyncPill() {
  const { t } = useI18n();
  const [online, setOnline] = useState(true);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return (
    <span className="sync-pill" data-offline={!online} role="status">
      <span className="dot" />
      {online ? t('online') : t('offline')}
    </span>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

/** Shows only when the browser offers installation. */
export function InstallButton() {
  const { t } = useI18n();
  const [evt, setEvt] = useState<BeforeInstallPromptEvent | null>(null);
  useEffect(() => {
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setEvt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    return () => window.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);
  if (!evt) return null;
  return (
    <button
      className="icon-btn"
      aria-label={t('installApp')}
      title={t('installApp')}
      onClick={async () => {
        await evt.prompt();
        setEvt(null);
      }}
    >
      <IconDownload />
    </button>
  );
}
