'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';
import { IconX } from './icons';

export function Dialog({ title, onClose, children, actions }: { title: string; onClose: () => void; children: ReactNode; actions?: ReactNode }) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    ref.current?.querySelector<HTMLElement>('input,select,textarea,button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="dialog-scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="dialog-head">
          <h2 className="dialog-title">{title}</h2>
          <button className="icon-btn" style={{ width: 48, height: 48 }} onClick={onClose} aria-label={t('close')}>
            <IconX />
          </button>
        </div>
        {children}
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>
  );
}

/** Destructive button: first tap arms (solid red), second tap confirms. */
export function ArmButton({ label, onConfirm, small = true }: { label: string; onConfirm: () => Promise<void> | void; small?: boolean }) {
  const { t } = useI18n();
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <button
      className={`btn btn-danger ${small ? 'btn-sm' : ''}`}
      data-armed={armed}
      disabled={busy}
      onClick={async () => {
        if (!armed) return setArmed(true);
        setBusy(true);
        try {
          await onConfirm();
        } finally {
          setBusy(false);
          setArmed(false);
        }
      }}
    >
      {armed ? t('confirm') : label}
    </button>
  );
}

export function Field({ label, hint, error, children }: { label: string; hint?: string; error?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {error ? <span className="field-error">{error}</span> : hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Empty({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {body && <span>{body}</span>}
      {action}
    </div>
  );
}

export function PageHead({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1 className="page-title">{title}</h1>
        {sub && <p className="page-sub">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  useEffect(() => {
    const id = setTimeout(onDone, 2500);
    return () => clearTimeout(id);
  }, [onDone]);
  return (
    <div className="banner" role="status">
      {message}
    </div>
  );
}

/** Initials that skip the Arabic article "ال" so "المخزن الجاف" gives "مج", not "اا". */
export function initials(name: string, max = 2) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, max)
    .map((w) => (w.startsWith('ال') && w.length > 2 ? w[2] : w[0]))
    .join('')
    .toUpperCase();
}

/** Short relative time: "6m", "2h 14m", "3d 4h". */
export function shortAgo(iso: string, lang: string) {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  const ar = lang === 'ar';
  const u = ar ? { m: 'د', h: 'س', d: 'ي' } : { m: 'm', h: 'h', d: 'd' };
  if (mins < 60) return `${mins}${u.m}`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}${u.h} ${mins % 60}${u.m}`;
  return `${Math.floor(h / 24)}${u.d} ${h % 24}${u.h}`;
}
