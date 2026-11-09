'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ArmButton, Empty, PageHead, Toast } from '@/components/ui';
import { IconMic } from '@/components/icons';
import { CountStatusTag, unitLabel, unitsFor, useSpeech } from '@/components/counts';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { CountDetail, CountLine, ParsedEntry } from '@/lib/types-counts';

export default function CountPage() {
  const { id } = useParams<{ id: string }>();
  const { t, pick, fmtMoney } = useI18n();
  const { api, can } = useSession();
  const { data: count, setData, error: loadError } = useApi<CountDetail>(`/stock-counts/${id}`, [id]);
  const [q, setQ] = useState('');
  const [uncountedOnly, setUncountedOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const lines = count?.lines ?? [];
  const counted = lines.filter((l) => l.countedQty !== null).length;
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return lines.filter(
      (l) =>
        (!uncountedOnly || l.countedQty === null) &&
        (!needle || l.name.toLowerCase().includes(needle) || (l.nameAr ?? '').includes(needle) || (l.code ?? '').toLowerCase().includes(needle)),
    );
  }, [lines, q, uncountedOnly]);
  const live = count?.expectedVisible ? lines.reduce((s, l) => s + Number(l.varianceValue ?? 0), 0) : null;
  const open = count?.status === 'open';
  const canManage = can('stock:manage');

  const act = async (path: string, body?: unknown, message?: string) => {
    setError(null);
    try {
      setData(await api<CountDetail>(`/stock-counts/${id}/${path}`, { method: 'POST', body: body ?? {} }));
      if (message) setToast(message);
    } catch (e) {
      setError((e as ApiError).message);
    }
  };

  if (loadError) return <div className="page"><div className="notice notice-error">{loadError.message}</div></div>;
  if (!count) return <div className="page" />;

  return (
    <div className="page">
      <PageHead
        title={count.ref}
        sub={`${pick({ name: count.siteName, nameAr: count.siteNameAr })} · ${t(count.scope === 'full' ? 'fullCount' : 'partialCount')}${count.blind ? ` · ${t('blindCount')}` : ''}`}
        action={<CountStatusTag status={count.status} needsApproval={count.needsApproval} />}
      />
      {error && <div className="notice notice-error">{error}</div>}

      <section className="card" style={{ gap: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, flexWrap: 'wrap' }}>
          <div>
            <span className="muted">{t('progress')} </span>
            <strong className="num">
              {counted} {t('ofItems')} {lines.length}
            </strong>
          </div>
          {live !== null && can('price:read') && (
            <div className="num">
              <span className="muted">{t('netVariance')} </span>
              <strong className={live < 0 ? 'cell-flag' : ''}>{fmtMoney(count.varianceValue ?? live)}</strong>
              {count.absVarianceValue && (
                <span className="faint" style={{ fontSize: 12 }}>
                  {' '}
                  · {t('grossVariance')} {fmtMoney(count.absVarianceValue)}
                </span>
              )}
            </div>
          )}
        </div>
        <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={lines.length} aria-valuenow={counted}>
          <span style={{ width: `${lines.length ? (counted / lines.length) * 100 : 0}%` }} />
        </div>
      </section>

      {open && canManage && <SayBox countId={count.id} onRecorded={(d, n) => { setData(d); setToast(`${n} ${t('recordedN')}`); }} onFind={setQ} />}

      <div className="filters">
        <input className="input" type="search" placeholder={t('searchItems')} value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 220px' }} />
        <button className="chip" aria-pressed={uncountedOnly} onClick={() => setUncountedOnly(!uncountedOnly)}>
          {t('uncountedOnly')} <span className="num">{lines.length - counted}</span>
        </button>
      </div>

      {shown.length === 0 ? (
        <div className="card">
          <Empty title={t('noItems')} />
        </div>
      ) : (
        <div className="count-lines">
          {shown.map((l) => (
            <LineCard key={l.itemId} line={l} count={count} editable={open && canManage} onSaved={setData} onError={setError} />
          ))}
        </div>
      )}

      {canManage && (count.status === 'open' || count.status === 'submitted') && (
        <div className="count-bar">
          {count.status === 'open' ? (
            <>
              <span className="faint" style={{ fontSize: 13, flex: '1 1 200px' }}>
                {t('submitCountHint')}
              </span>
              <div style={{ display: 'flex', gap: 8 }}>
                <ArmButton label={t('cancelCount')} small={false} onConfirm={() => act('cancel')} />
                <button className="btn btn-primary" disabled={counted === 0} onClick={() => act('submit')}>
                  {t('submitCount')}
                </button>
              </div>
            </>
          ) : (
            <>
              <span style={{ fontSize: 13, flex: '1 1 220px' }} className={count.needsApproval ? 'cell-flag' : 'faint'}>
                {count.needsApproval ? t('needsCountApproval') : t('submitCountHint')}
              </span>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn btn-quiet" onClick={() => act('reopen')}>
                  {t('reopenCount')}
                </button>
                <button className="btn btn-primary" disabled={count.needsApproval && !count.canApprove} onClick={() => act('post', undefined, t('countPosted'))}>
                  {t('postCount')}
                </button>
              </div>
            </>
          )}
        </div>
      )}
      <div>
        <Link href="/stock/counts" className="link-btn">
          ← {t('counts')}
        </Link>
      </div>
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

/** One item: what was counted, and (when allowed) a quick quantity + unit entry. */
function LineCard({ line, count, editable, onSaved, onError }: { line: CountLine; count: CountDetail; editable: boolean; onSaved: (d: CountDetail) => void; onError: (m: string) => void }) {
  const { t, pick, lang, fmtQty, fmtMoney } = useI18n();
  const { api, can } = useSession();
  const options = useMemo(
    () => [...line.packs.map((p) => ({ key: `pack:${p.id}`, label: lang === 'ar' && p.nameAr ? p.nameAr : p.name })), ...unitsFor(line.baseUnit).map((u) => ({ key: `unit:${u}`, label: unitLabel(u, lang) }))],
    [line, lang],
  );
  const initialKey = line.entryPackId ? `pack:${line.entryPackId}` : line.entryUnit ? `unit:${line.entryUnit}` : options[0]?.key ?? '';
  const [unit, setUnit] = useState(initialKey);
  const [qty, setQty] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => setUnit(initialKey), [initialKey]);

  const save = async () => {
    const n = Number(qty.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace('٫', '.'));
    if (qty.trim() === '' || !Number.isFinite(n) || n < 0) return;
    setBusy(true);
    try {
      const [kind, ref] = unit.split(':');
      const d = await api<CountDetail>(`/stock-counts/${count.id}/lines`, { method: 'PATCH', body: { lines: [{ itemId: line.itemId, qty: n, ...(kind === 'pack' ? { packId: ref } : { unit: ref }) }] } });
      onSaved(d);
      setQty('');
    } catch (e) {
      onError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  const entryPack = line.packs.find((p) => p.id === line.entryPackId);
  const entryLabel = line.entryQty !== null ? `${Number(line.entryQty)} ${entryPack ? (lang === 'ar' && entryPack.nameAr ? entryPack.nameAr : entryPack.name) : unitLabel(line.entryUnit ?? line.baseUnit, lang)}` : null;
  const adj = line.adjustmentQty !== undefined && line.adjustmentQty !== null ? Number(line.adjustmentQty) : null;

  return (
    <div className={`count-line${line.countedQty !== null ? ' is-counted' : ''}`}>
      <div>
        <div className="count-line-name">{pick(line)}</div>
        <div className="count-line-meta">
          {line.countedQty !== null ? (
            <>
              <strong className="num">{fmtQty(line.countedQty, line.baseUnit)}</strong>
              {entryLabel && entryPack && <span className="num"> · {entryLabel}</span>}
              {line.countedByName && (
                <span className="faint">
                  {' '}
                  · {t('countedBy')} {line.countedByName}
                </span>
              )}
            </>
          ) : (
            <span className="faint">{t('notCounted')}</span>
          )}
        </div>
      </div>
      {editable && (
        <form
          className="count-entry"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          <input className="input num" inputMode="decimal" placeholder={line.countedQty !== null ? '' : '0'} value={qty} onChange={(e) => setQty(e.target.value)} aria-label={`${t('counted')} · ${pick(line)}`} />
          <select className="select" value={unit} onChange={(e) => setUnit(e.target.value)} aria-label={t('in')}>
            {options.map((o) => (
              <option key={o.key} value={o.key}>
                {o.label}
              </option>
            ))}
          </select>
          <button className="btn btn-sm btn-primary" disabled={busy || qty.trim() === ''}>
            {t('save')}
          </button>
        </form>
      )}
      {count.expectedVisible && line.countedQty !== null && line.expectedQty != null && (
        <div className="count-variance">
          <span>
            {t('expected')} <span className="num">{fmtQty(line.expectedQty, line.baseUnit)}</span>
          </span>
          {adj !== null && (
            <span>
              {t('variance')}{' '}
              <span className={`num ${adj < 0 ? 'neg' : adj > 0 ? 'pos' : ''}`}>
                {adj > 0 ? '+' : ''}
                {fmtQty(adj, line.baseUnit)}
              </span>
              {can('price:read') && line.varianceValue != null && Number(line.varianceValue) !== 0 && <span className="num"> · {fmtMoney(line.varianceValue)}</span>}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** Type or say counts; shows how each piece was read, then records the clear ones. */
function SayBox({ countId, onRecorded, onFind }: { countId: string; onRecorded: (d: CountDetail, n: number) => void; onFind: (q: string) => void }) {
  const { t, lang, pick } = useI18n();
  const { api } = useSession();
  const [text, setText] = useState('');
  const [speechLang, setSpeechLang] = useState<'ar' | 'en'>(lang === 'ar' ? 'ar' : 'en');
  const [entries, setEntries] = useState<ParsedEntry[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speech = useSpeech((phrase) => setText((cur) => (cur.trim() ? `${cur.trim()}، ${phrase}` : phrase)));

  const read = async (apply: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ entries: ParsedEntry[]; recorded: number }>(`/stock-counts/${countId}/entries`, { method: 'POST', body: { text, apply } });
      if (apply) {
        const d = await api<CountDetail>(`/stock-counts/${countId}`);
        onRecorded(d, r.recorded);
        // Keep only what wasn't understood, so it can be fixed and read again.
        const left = r.entries.filter((e) => !e.recorded).map((e) => e.raw);
        setText(left.join('، '));
        setEntries(left.length ? r.entries.filter((e) => !e.recorded) : null);
      } else setEntries(r.entries);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const clear = entries?.filter((e) => !e.problem).length ?? 0;

  return (
    <section className="card say-box" style={{ gap: 10 }}>
      <div className="card-title" style={{ fontSize: 15 }}>
        {t('typeOrSay')}
      </div>
      <textarea
        className="input"
        dir="auto"
        value={speech.listening && speech.interim ? `${text} ${speech.interim}` : text}
        onChange={(e) => {
          setText(e.target.value);
          setEntries(null);
        }}
        placeholder={t('typeOrSayHint')}
        aria-label={t('typeOrSay')}
      />
      {error && <div className="notice notice-error">{error}</div>}
      {!speech.supported && <div className="faint" style={{ fontSize: 12 }}>{t('speechUnsupported')}</div>}
      <div className="say-actions">
        {speech.supported && (
          <>
            <button type="button" className={`btn btn-quiet${speech.listening ? ' btn-listening' : ''}`} onClick={() => (speech.listening ? speech.stop() : speech.start(speechLang))}>
              <IconMic /> {speech.listening ? t('listening') : t('speak')}
            </button>
            <div className="segmented" role="group" aria-label="Speech language">
              {(['ar', 'en'] as const).map((l) => (
                <button key={l} type="button" aria-pressed={speechLang === l} onClick={() => setSpeechLang(l)} style={{ minHeight: 36, paddingInline: 12 }}>
                  {l === 'ar' ? 'ع' : 'EN'}
                </button>
              ))}
            </div>
          </>
        )}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-quiet" disabled={busy || !text.trim()} onClick={() => read(false)}>
          {t('readIt')}
        </button>
        {entries && clear > 0 && (
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => read(true)}>
            {t('recordN')} <span className="num">{clear}</span>
          </button>
        )}
      </div>
      {entries && (
        <div className="entry-list">
          {entries.map((e, i) => (
            <div key={i} className={`entry${e.problem ? '' : ' entry-ok'}`}>
              <span dir="auto" className="muted">
                {e.raw}
              </span>
              <span style={{ textAlign: 'end' }}>
                {e.problem ? (
                  <>
                    <span className="cell-flag">{t(`problem_${e.problem}` as TKey)}</span>
                    {e.problem === 'ambiguous_item' &&
                      e.candidateNames.map((c) => (
                        <button key={c.id} type="button" className="link-btn" style={{ marginInlineStart: 8 }} onClick={() => onFind(c.name ?? '')}>
                          {pick({ name: c.name ?? '', nameAr: c.nameAr ?? null })}
                        </button>
                      ))}
                    {e.itemName && e.problem !== 'ambiguous_item' && <span className="faint"> · {pick({ name: e.itemName, nameAr: e.itemNameAr })}</span>}
                  </>
                ) : (
                  <>
                    <strong>{pick({ name: e.itemName ?? '', nameAr: e.itemNameAr })}</strong> <span className="num">{e.qty}</span>{' '}
                    {e.packName ? pick({ name: e.packName, nameAr: e.packNameAr }) : e.unit ? unitLabel(e.unit, lang) : ''}
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
