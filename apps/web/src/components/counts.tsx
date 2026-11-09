'use client';

import { useEffect, useRef, useState } from 'react';
import { useI18n, type TKey } from '@/lib/i18n';
import type { CountStatus } from '@/lib/types-counts';

export function CountStatusTag({ status, needsApproval }: { status: CountStatus; needsApproval?: boolean }) {
  const { t } = useI18n();
  const tone = status === 'submitted' ? 'tag-late' : status === 'posted' ? 'tag-accent' : '';
  return (
    <span className={`tag ${tone}`}>
      <span className="dot" />
      {t(`count_${status}` as TKey)}
      {status === 'submitted' && needsApproval ? ` · ${t('needsApproval')}` : ''}
    </span>
  );
}

/** Units a person can count an item in, from its base unit. */
export function unitsFor(baseUnit: string): string[] {
  if (baseUnit === 'g') return ['kg', 'g'];
  if (baseUnit === 'ml') return ['l', 'ml'];
  return ['each'];
}

export function unitLabel(u: string, lang: string) {
  const ar: Record<string, string> = { kg: 'كجم', g: 'غ', l: 'لتر', ml: 'مل', each: 'حبة', dozen: 'درزن' };
  const en: Record<string, string> = { kg: 'kg', g: 'g', l: 'L', ml: 'ml', each: 'each', dozen: 'dozen' };
  return (lang === 'ar' ? ar : en)[u] ?? u;
}

type Recognition = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
};

/**
 * Speech to text with the browser's Web Speech API. Arabic (Saudi) or English;
 * calls onText with each finished phrase.
 */
export function useSpeech(onText: (text: string) => void) {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [supported, setSupported] = useState(true);
  const rec = useRef<Recognition | null>(null);
  const cb = useRef(onText);
  cb.current = onText;
  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    setSupported(Boolean(w.SpeechRecognition ?? w.webkitSpeechRecognition));
    return () => rec.current?.stop();
  }, []);
  const start = (lang: 'ar' | 'en') => {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return setSupported(false);
    const r = new Ctor();
    r.lang = lang === 'ar' ? 'ar-SA' : 'en-US';
    r.interimResults = true;
    r.continuous = true;
    r.onresult = (e) => {
      let live = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (res.isFinal) cb.current(res[0]!.transcript.trim());
        else live += res[0]!.transcript;
      }
      setInterim(live);
    };
    r.onend = () => {
      setListening(false);
      setInterim('');
    };
    r.onerror = () => setListening(false);
    rec.current = r;
    r.start();
    setListening(true);
  };
  const stop = () => rec.current?.stop();
  return { listening, interim, supported, start, stop };
}
