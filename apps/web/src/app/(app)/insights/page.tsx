'use client';

import { useEffect, useRef, useState } from 'react';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { IconArrowUp, IconMic } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';

/*
 * Agent screen preview, styled with the AI Insights spec.
 * The agent is not connected yet (phase 8): every answer here is clearly labelled sample data.
 */

const SAMPLE_TREND = [
  { d: 'Sat', v: 29.8 },
  { d: 'Sun', v: 30.1 },
  { d: 'Mon', v: 30.4 },
  { d: 'Tue', v: 31.2 },
  { d: 'Wed', v: 32.0 },
  { d: 'Thu', v: 32.9 },
  { d: 'Fri', v: 32.6 },
];
const SAMPLE_TREND_AR = ['السبت', 'الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة'];

const copy = {
  en: {
    answer:
      'Food cost at Olaya rose 2.8 points vs last week, to 32.6%. Most of it is salmon (up 14% from your supplier) and unrecorded waste on the grill station.',
    k1: 'Food cost', k2: 'vs last week', k3: 'Biggest driver',
    salmon: 'Salmon fillet',
    t1: 'Cause', t2: 'Share', t3: 'Impact',
    r1: 'Salmon price increase', r2: 'Unrecorded grill waste', r3: 'Sales mix shift',
    chart: 'Food cost %, last 7 days', chartSub: 'Olaya branch',
    a1: 'Compare salmon suppliers', a2: 'Start a waste log for grill', a3: 'Show by dish',
  },
  ar: {
    answer:
      'ارتفعت تكلفة الطعام في فرع العليا 2.8 نقطة مقارنة بالأسبوع الماضي، إلى 32.6٪. معظم الارتفاع من السلمون (زاد سعره 14٪ لدى المورد) وهدر غير مسجل في محطة الشواء.',
    k1: 'تكلفة الطعام', k2: 'مقارنة بالأسبوع الماضي', k3: 'السبب الأكبر',
    salmon: 'فيليه سلمون',
    t1: 'السبب', t2: 'الحصة', t3: 'الأثر',
    r1: 'ارتفاع سعر السلمون', r2: 'هدر الشواء غير المسجل', r3: 'تغير مزيج المبيعات',
    chart: 'نسبة تكلفة الطعام، آخر 7 أيام', chartSub: 'فرع العليا',
    a1: 'قارن موردي السلمون', a2: 'ابدأ سجل هدر للشواء', a3: 'اعرض حسب الطبق',
  },
};

export default function InsightsPage() {
  const { t, lang, fmtNum } = useI18n();
  const [asked, setAsked] = useState<string | null>(null);
  const [thinking, setThinking] = useState(false);
  const [text, setText] = useState('');
  const area = useRef<HTMLTextAreaElement>(null);
  const c = copy[lang];

  useEffect(() => {
    if (!thinking) return;
    const id = setTimeout(() => setThinking(false), 900);
    return () => clearTimeout(id);
  }, [thinking]);

  const ask = (q: string) => {
    if (!q.trim()) return;
    setAsked(q.trim());
    setText('');
    setThinking(true);
  };

  const data = SAMPLE_TREND.map((p, i) => ({ ...p, d: lang === 'ar' ? SAMPLE_TREND_AR[i] : p.d }));
  const fmt = (n: number, digits = 1) => fmtNum(n, digits);

  return (
    <div className="ai">
      <div className="ai-thread">
        {!asked && (
          <div className="ai-empty">
            <h2>{t('insightsTitle')}</h2>
            <p>{t('insightsLead')}</p>
            <div className="ai-chips">
              {(['q1', 'q2', 'q3', 'q4'] as TKey[]).map((k) => (
                <button key={k} className="ai-chip" onClick={() => ask(t(k))}>
                  {t(k)}
                </button>
              ))}
            </div>
          </div>
        )}

        {asked && <div className="ai-msg-user">{asked}</div>}
        {asked && thinking && (
          <div className="ai-typing" aria-label={t('loading')}>
            <span />
            <span />
            <span />
          </div>
        )}
        {asked && !thinking && (
          <div className="ai-msg-bot">
            <span className="ai-sample">{t('sampleData')}</span>
            <p>{c.answer}</p>
            <div className="ai-kpis">
              <div className="ai-kpi">
                <div className="ai-kpi-label">{c.k1}</div>
                <div className="ai-kpi-value mono">{fmt(32.6)}%</div>
                <div className="ai-delta-up">
                  <span className="mono">+{fmt(2.8)}</span> {c.k2}
                </div>
              </div>
              <div className="ai-kpi">
                <div className="ai-kpi-label">{c.k3}</div>
                <div className="ai-kpi-value" style={{ fontSize: 18 }}>{c.salmon}</div>
                <div className="ai-delta-up mono">+14%</div>
              </div>
            </div>
            <div className="ai-card">
              <div>
                <div className="ai-card-title">{c.chart}</div>
                <div className="ai-card-sub">{c.chartSub}</div>
              </div>
              <div style={{ width: '100%', height: 280 }} dir="ltr">
                <ResponsiveContainer>
                  <AreaChart data={lang === 'ar' ? [...data].reverse() : data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                    <defs>
                      <linearGradient id="fc" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--c1)" stopOpacity={0.25} />
                        <stop offset="100%" stopColor="var(--c1)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid vertical={false} stroke="var(--border)" />
                    <XAxis dataKey="d" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: 'var(--faint)', fontFamily: 'JetBrains Mono' }} />
                    <YAxis
                      domain={[28, 34]}
                      orientation={lang === 'ar' ? 'right' : 'left'}
                      axisLine={false}
                      tickLine={false}
                      tick={{ fontSize: 11, fill: 'var(--faint)', fontFamily: 'JetBrains Mono' }}
                      tickFormatter={(v) => `${v}%`}
                    />
                    <Tooltip
                      contentStyle={{ background: 'var(--a-card)', border: '1px solid var(--border)', borderRadius: 10, fontSize: 12 }}
                      labelStyle={{ fontWeight: 800, color: 'var(--text)' }}
                      formatter={(v: number) => [`${fmt(v)}%`, c.k1]}
                    />
                    <Area isAnimationActive={false} type="monotone" dataKey="v" stroke="var(--c1)" strokeWidth={3} fill="url(#fc)" dot={{ r: 3.5, fill: 'var(--c1)' }} activeDot={{ r: 5 }} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            <div className="ai-table-wrap">
              <table className="ai-table">
                <thead>
                  <tr>
                    <th>{c.t1}</th>
                    <th className="end">{c.t2}</th>
                    <th className="end">{c.t3}</th>
                  </tr>
                </thead>
                <tbody>
                  {[
                    [c.r1, 60, 1.7],
                    [c.r2, 30, 0.8],
                    [c.r3, 10, 0.3],
                  ].map(([label, share, pts]) => (
                    <tr key={label as string}>
                      <td>{label}</td>
                      <td className="end mono">{share}%</td>
                      <td className="end mono">+{fmt(pts as number)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="ai-actions">
              {[c.a1, c.a2, c.a3].map((a) => (
                <button key={a} className="ai-action" disabled title={t('insightsSoon')}>
                  {a}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="ai-composer-wrap">
        <form
          className="ai-composer"
          onSubmit={(e) => {
            e.preventDefault();
            ask(text);
          }}
        >
          <textarea
            ref={area}
            rows={1}
            value={text}
            placeholder={t('askPlaceholder')}
            aria-label={t('askPlaceholder')}
            onChange={(e) => {
              setText(e.target.value);
              e.target.style.height = 'auto';
              e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                ask(text);
              }
            }}
          />
          <button type="button" className="ai-round" aria-label={t('voice')} title={t('insightsSoon')} disabled>
            <IconMic />
          </button>
          <button type="submit" className="ai-round ai-send" aria-label={t('ask')} disabled={!text.trim()}>
            <IconArrowUp />
          </button>
        </form>
        <div className="ai-note">{t('insightsSoon')}</div>
      </div>
    </div>
  );
}
