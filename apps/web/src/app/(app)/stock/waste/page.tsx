'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArmButton, Empty, Field, PageHead, Toast } from '@/components/ui';
import { IconMic } from '@/components/icons';
import { unitLabel, useSpeech } from '@/components/counts';
import { StockTabs, qtyRef, readNumber, useEntryLabel, useQtyOptions } from '@/components/stock';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Site } from '@/lib/types';
import { WASTE_REASONS, type ParsedWaste, type StockItem, type WasteEntry, type WasteReason, type WasteSummary } from '@/lib/types-stock';

const daysAgo = (n: number) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

export default function WastePage() {
  const { t, pick, fmtMoney, fmtQty, fmtDate } = useI18n();
  const { me, can } = useSession();
  const { data: sites } = useApi<Site[]>('/sites');
  const { data: catalogue } = useApi<StockItem[]>('/stock-items');
  const [siteId, setSiteId] = useState('');
  const [days, setDays] = useState<7 | 30>(7);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!siteId && sites?.[0]) setSiteId(sites[0].id);
  }, [sites, siteId]);
  const from = daysAgo(days);
  const { data: summary, reload: reloadSummary } = useApi<WasteSummary>(siteId ? `/waste/summary?siteId=${siteId}&from=${from}` : null, [siteId, from]);
  const { data: rows, reload: reloadRows } = useApi<WasteEntry[]>(siteId ? `/waste?siteId=${siteId}&from=${from}&includeVoided=true` : null, [siteId, from]);
  const canLog = !!me?.memberships.some(
    (m) => m.permissions.some((p) => p === '*' || p === 'stock:manage' || p === 'stock:*') && (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(siteId)),
  );
  const refresh = (message?: string) => {
    reloadSummary();
    reloadRows();
    if (message) setToast(message);
  };
  const maxReason = Math.max(1, ...(summary?.byReason.map((r) => Number(r.value ?? r.entries)) ?? [1]));
  const entryLabel = useEntryLabel();
  const byId = useMemo(() => new Map((catalogue ?? []).map((i) => [i.id, i])), [catalogue]);
  const showCost = can('price:read');

  return (
    <div className="page">
      <PageHead title={t('waste')} sub={t('wasteSub')} />
      <StockTabs />
      <div className="filters">
        <select className="select" style={{ flex: '0 1 260px' }} value={siteId} onChange={(e) => setSiteId(e.target.value)} aria-label={t('site')}>
          {sites?.map((s) => (
            <option key={s.id} value={s.id}>
              {pick(s)}
            </option>
          ))}
        </select>
        <div className="segmented" role="group">
          {([7, 30] as const).map((d) => (
            <button key={d} aria-pressed={days === d} onClick={() => setDays(d)}>
              {t(d === 7 ? 'wasteLast7' : 'wasteLast30')}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="notice notice-error">{error}</div>}

      {canLog && siteId && catalogue && (
        <section className="card" style={{ gap: 14 }}>
          <div className="card-title">{t('logWaste')}</div>
          <WasteSayBox siteId={siteId} onRecorded={(n) => refresh(`${n} · ${t('wasteLogged')}`)} />
          <WasteForm siteId={siteId} items={catalogue} onDone={() => refresh(t('wasteLogged'))} onError={setError} />
        </section>
      )}

      {summary && (
        <div className="stats">
          {showCost && (
            <div className="stat">
              <div className="stat-label">{t('wasteTotal')}</div>
              <div className="stat-value" style={{ fontSize: 22 }}>
                {fmtMoney(summary.total ?? 0)}
              </div>
            </div>
          )}
          <div className="stat">
            <div className="stat-label">{t('wasteEntries')}</div>
            <div className="stat-value">{summary.entries}</div>
          </div>
        </div>
      )}

      {summary && summary.entries > 0 && (
        <div className="split-2">
          <section className="card" style={{ gap: 12 }}>
            <div className="card-title" style={{ fontSize: 15 }}>
              {t('byReason')}
            </div>
            <div className="bar-list">
              {summary.byReason.map((r) => (
                <div key={r.reason} className="bar-row">
                  <div className="bar-row-head">
                    <span>{t(`reason_${r.reason}` as TKey)}</span>
                    <span className="num muted">{showCost ? fmtMoney(r.value ?? 0) : r.entries}</span>
                  </div>
                  <div className="bar-track">
                    <span style={{ width: `${(Number(r.value ?? r.entries) / maxReason) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </section>
          <section className="card" style={{ gap: 12 }}>
            <div className="card-title" style={{ fontSize: 15 }}>
              {t('topWasted')}
            </div>
            <div className="bar-list">
              {summary.topItems.map((i) => (
                <div key={i.itemId} className="bar-row-head" style={{ fontSize: 14 }}>
                  <span>
                    {pick(i)} <span className="faint num">· {fmtQty(i.qtyBase, i.baseUnit)}</span>
                  </span>
                  {showCost && <span className="num muted">{fmtMoney(i.value ?? 0)}</span>}
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {rows && rows.length === 0 ? (
        <div className="card">
          <Empty title={t('noWaste')} body={t('noWasteBody')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('item')}</th>
                <th className="end">{t('qty')}</th>
                <th>{t('reason')}</th>
                {showCost && <th className="end hide-phone">{t('value')}</th>}
                <th className="hide-phone">{t('date')}</th>
                {canLog && <th className="end" />}
              </tr>
            </thead>
            <tbody>
              {rows?.map((w) => (
                <tr key={w.id} className={w.voidedAt ? 'is-voided' : ''}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{pick({ name: w.itemName, nameAr: w.itemNameAr })}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                      <span className="hide-phone">{w.recordedByName}</span>
                      {w.note ? <span> · {w.note}</span> : ''}
                      {w.voidedAt ? ` · ${t('voided')}: ${w.voidReason}` : ''}
                    </div>
                  </td>
                  <td className="end num">
                    {fmtQty(w.qtyBase, w.baseUnit)}
                    {w.entryPackId && (
                      <div className="faint" style={{ fontSize: 12 }}>
                        {entryLabel(w.entryQty, w.entryUnit, w.entryPackId, byId.get(w.itemId)?.packs ?? [], w.baseUnit)}
                      </div>
                    )}
                  </td>
                  <td>
                    <span className="tag">{t(`reason_${w.reason}` as TKey)}</span>
                  </td>
                  {showCost && <td className="end num hide-phone">{w.value ? fmtMoney(w.value) : '–'}</td>}
                  <td className="hide-phone num muted">{fmtDate(w.recordedAt)}</td>
                  {canLog && (
                    <td className="end">
                      {!w.voidedAt && <VoidButton id={w.id} onDone={() => refresh()} onError={setError} />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {toast && <Toast message={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function VoidButton({ id, onDone, onError }: { id: string; onDone: () => void; onError: (m: string) => void }) {
  const { t } = useI18n();
  const { api } = useSession();
  return (
    <ArmButton
      label={t('voidEntry')}
      onConfirm={async () => {
        const reason = window.prompt(t('voidReasonPrompt'));
        if (!reason || reason.trim().length < 2) return;
        try {
          await api(`/waste/${id}/void`, { method: 'POST', body: { reason: reason.trim() } });
          onDone();
        } catch (e) {
          onError((e as ApiError).message);
        }
      }}
    />
  );
}

/** Pick an item, a quantity and a reason. */
function WasteForm({ siteId, items, onDone, onError }: { siteId: string; items: StockItem[]; onDone: () => void; onError: (m: string) => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const [q, setQ] = useState('');
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState('');
  const [unit, setUnit] = useState('');
  const [reason, setReason] = useState<WasteReason | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const item = items.find((i) => i.id === itemId);
  const options = useQtyOptions(item);
  useEffect(() => setUnit(options.find((o) => o.key.startsWith('unit:'))?.key ?? options[0]?.key ?? ''), [options]);
  const needle = q.trim().toLowerCase();
  const shown = needle ? items.filter((i) => i.name.toLowerCase().includes(needle) || (i.nameAr ?? '').includes(needle) || (i.code ?? '').toLowerCase().includes(needle)) : items;
  const n = readNumber(qty);
  const ready = item && qty.trim() !== '' && Number.isFinite(n) && n > 0 && reason;

  return (
    <form
      style={{ display: 'grid', gap: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        if (!ready) return;
        setBusy(true);
        try {
          await api(`/sites/${siteId}/waste`, { method: 'POST', body: { entries: [{ itemId, qty: n, ...qtyRef(unit), reason, note: note.trim() || null }] } });
          setQty('');
          setNote('');
          setReason(null);
          onDone();
        } catch (err) {
          onError((err as ApiError).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-row">
        <Field label={t('item')}>
          <input className="input" type="search" placeholder={t('searchItems')} value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="select" value={itemId} onChange={(e) => setItemId(e.target.value)} style={{ marginTop: 6 }}>
            <option value="">{t('pickItem')}</option>
            {shown.map((i) => (
              <option key={i.id} value={i.id}>
                {pick(i)}
              </option>
            ))}
          </select>
        </Field>
        <Field label={t('qty')}>
          <div className="qty-row">
            <input className="input num" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} disabled={!item} />
            <select className="select" value={unit} onChange={(e) => setUnit(e.target.value)} disabled={!item} aria-label={t('in')}>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
        </Field>
      </div>
      <Field label={t('reason')}>
        <div className="reason-chips">
          {WASTE_REASONS.map((r) => (
            <button key={r} type="button" className="chip" aria-pressed={reason === r} onClick={() => setReason(r)}>
              {t(`reason_${r}` as TKey)}
            </button>
          ))}
        </div>
      </Field>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 240px' }}>
          <Field label={t('note')}>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          </Field>
        </div>
        <button className="btn btn-primary" disabled={!ready || busy}>
          {t('logWaste')}
        </button>
      </div>
    </form>
  );
}

/** Type or say waste; shows how each entry was read, then logs the clear ones. */
function WasteSayBox({ siteId, onRecorded }: { siteId: string; onRecorded: (n: number) => void }) {
  const { t, lang, pick } = useI18n();
  const { api } = useSession();
  const [text, setText] = useState('');
  const [speechLang, setSpeechLang] = useState<'ar' | 'en'>(lang === 'ar' ? 'ar' : 'en');
  const [entries, setEntries] = useState<ParsedWaste[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const speech = useSpeech((phrase) => setText((cur) => (cur.trim() ? `${cur.trim()}، ${phrase}` : phrase)));
  const read = async (apply: boolean) => {
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ entries: ParsedWaste[]; recorded: number }>(`/sites/${siteId}/waste/read`, { method: 'POST', body: { text, apply } });
      if (apply) {
        onRecorded(r.recorded);
        const left = r.entries.filter((e) => !e.recorded);
        setText(left.map((e) => e.raw).join('، '));
        setEntries(left.length ? left : null);
      } else setEntries(r.entries);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };
  const clear = entries?.filter((e) => !e.problem).length ?? 0;

  return (
    <div className="say-box" style={{ display: 'grid', gap: 10 }}>
      <textarea
        className="input"
        dir="auto"
        value={speech.listening && speech.interim ? `${text} ${speech.interim}` : text}
        onChange={(e) => {
          setText(e.target.value);
          setEntries(null);
        }}
        placeholder={t('wasteSayHint')}
        aria-label={t('typeOrSay')}
      />
      {error && <div className="notice notice-error">{error}</div>}
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
            {t('logWaste')} <span className="num">{clear}</span>
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
                  <span className="cell-flag">{t(`problem_${e.problem}` as TKey)}</span>
                ) : (
                  <>
                    <strong>{pick({ name: e.itemName ?? '', nameAr: e.itemNameAr })}</strong> <span className="num">{e.qty}</span>{' '}
                    {e.packName ? pick({ name: e.packName, nameAr: e.packNameAr }) : e.unit ? unitLabel(e.unit, lang) : ''}
                    {' · '}
                    <span className={e.reason ? '' : 'faint'}>{e.reason ? t(`reason_${e.reason}` as TKey) : t('noReasonSaid')}</span>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
