'use client';

import type { ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { LangButton, ThemeButton } from './toolbar';

export function AuthFrame({ title, children }: { title: string; children: ReactNode }) {
  const { t } = useI18n();
  return (
    <div className="auth">
      <section className="auth-hero" aria-hidden="true">
        {/* Decorative loop (no text, so the same for Arabic and English). Video is ~10× lighter than the GIF. */}
        <div className="auth-anim">
          <video autoPlay muted loop playsInline preload="auto" poster="/hero/poster.jpg" tabIndex={-1}>
            <source src="/hero/hero.webm" type="video/webm" />
            <source src="/hero/hero.mp4" type="video/mp4" />
          </video>
        </div>
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
          <img className="brand-logo" src="/icons/icon.svg" alt="" width={36} height={36} />
          <h2>{title}</h2>
        </div>
        {children}
      </section>
    </div>
  );
}
