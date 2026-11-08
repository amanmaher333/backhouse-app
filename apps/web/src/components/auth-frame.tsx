'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { LangButton, ThemeButton } from './toolbar';

export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="auth">
      <section className="auth-hero" aria-hidden="true">
        <span className="glass">{t('heroLabel')}</span>
        <h1>{t('heroTitle')}</h1>
        <p>{t('heroLead')}</p>
      </section>
      <section className="auth-panel">
        <div className="auth-tools">
          <LangButton />
          <ThemeButton />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div className="brand-logo">B</div>
          <h2>{title}</h2>
        </div>
        {children}
      </section>
    </div>
  );
}
