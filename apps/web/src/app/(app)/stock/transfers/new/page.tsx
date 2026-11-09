'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Field, PageHead } from '@/components/ui';
import { IconPlus, IconX } from '@/components/icons';
import { StockTabs, qtyRef, readNumber, useQtyOptions } from '@/components/stock';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { Site } from '@/lib/types';
import type { StockItem, TransferDetail } from '@/lib/types-stock';

interface Draft {
  key: number;
  itemId: string;
  qty: string;
  unit: string;
}

export default function NewTransferPage() {
  const { t, pick } = useI18n();
  const { api, me } = useSession();
  const router = useRouter();
  const { data: sites } = useApi<Site[]>('/sites');
  const { data: items } = useApi<StockItem[]>('/stock-items');
  const [fromSiteId, setFrom] = useState('');
  const [toSiteId, setTo] = useState('');
  const [lines, setLines] = useState<Draft[]>([{ key: 1, itemId: '', qty: '', unit: '' }]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canSendFrom = (siteId: string) =>
    !!me?.memberships.some((m) => m.permissions.some((p) => p === '*' || p === 'stock:manage' || p === 'stock:*') && (m.scope === 'org' || m.siteIds === null || m.siteIds.includes(siteId)));
  const fromChoices = sites?.filter((s) => canSendFrom(s.id)) ?? [];
  useEffect(() => {
    if (!sites) return;
    // Default: from a central kitchen or warehouse if there is one, to the first other site.
    const from = fromChoices.find((s) => s.type && s.type !== 'restaurant') ?? fromChoices[0];
    if (!fromSiteId && from) setFrom(from.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sites]);
  useEffect(() => {
    if (sites && (!toSiteId || toSiteId === fromSiteId)) setTo(sites.find((s) => s.id !== fromSiteId)?.id ?? '');
  }, [sites, fromSiteId, toSiteId]);

  const ready = fromSiteId && toSiteId && fromSiteId !== toSiteId && lines.some((l) => l.itemId) && lines.every((l) => !l.itemId || (readNumber(l.qty) > 0 && l.unit));
  const submit = async (send: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const body = {
        fromSiteId,
        toSiteId,
        send,
        note: note.trim() || null,
        lines: lines.filter((l) => l.itemId).map((l) => ({ itemId: l.itemId, qty: readNumber(l.qty), ...qtyRef(l.unit) })),
      };
      const tr = await api<TransferDetail>('/stock-transfers', { method: 'POST', body });
      router.push(`/stock/transfers/${tr.id}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead title={t('newTransfer')} sub={t('transfersSub')} />
      <StockTabs />
      {error && <div className="notice notice-error">{error}</div>}
      <section className="card" style={{ gap: 14 }}>
        <div className="form-row">
          <Field label={t('fromSite')}>
            <select className="select" value={fromSiteId} onChange={(e) => setFrom(e.target.value)}>
              {fromChoices.map((s) => (
                <option key={s.id} value={s.id}>
                  {pick(s)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('toSite')}>
            <select className="select" value={toSiteId} onChange={(e) => setTo(e.target.value)}>
              {sites
                ?.filter((s) => s.id !== fromSiteId)
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {pick(s)}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <div style={{ display: 'grid', gap: 8 }}>
          {lines.map((l, i) => (
            <LineEditor
              key={l.key}
              line={l}
              items={items ?? []}
              taken={lines.filter((x) => x.key !== l.key).map((x) => x.itemId)}
              onChange={(next) => setLines(lines.map((x) => (x.key === l.key ? next : x)))}
              onRemove={lines.length > 1 ? () => setLines(lines.filter((x) => x.key !== l.key)) : undefined}
              autoFocus={i > 0 && !l.itemId}
            />
          ))}
          <button type="button" className="btn btn-quiet" style={{ justifySelf: 'start' }} onClick={() => setLines([...lines, { key: Date.now(), itemId: '', qty: '', unit: '' }])}>
            <IconPlus /> {t('addItem')}
          </button>
        </div>
        <Field label={t('note')}>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
        </Field>
        <div className="faint" style={{ fontSize: 13 }}>
          {t('sendTransferHint')}
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button className="btn btn-quiet" disabled={!ready || busy} onClick={() => submit(false)}>
            {t('saveDraftTransfer')}
          </button>
          <button className="btn btn-primary" disabled={!ready || busy} onClick={() => submit(true)}>
            {t('sendTransfer')}
          </button>
        </div>
      </section>
    </div>
  );
}

function LineEditor({ line, items, taken, onChange, onRemove, autoFocus }: { line: Draft; items: StockItem[]; taken: string[]; onChange: (l: Draft) => void; onRemove?: () => void; autoFocus?: boolean }) {
  const { t, pick } = useI18n();
  const item = items.find((i) => i.id === line.itemId);
  const options = useQtyOptions(item);
  useEffect(() => {
    if (item && !options.some((o) => o.key === line.unit)) onChange({ ...line, unit: options[0]?.key ?? '' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item, options]);
  return (
    <div className="transfer-line">
      <select className="select" value={line.itemId} onChange={(e) => onChange({ ...line, itemId: e.target.value })} aria-label={t('item')} autoFocus={autoFocus}>
        <option value="">{t('pickItem')}</option>
        {items
          .filter((i) => i.id === line.itemId || !taken.includes(i.id))
          .map((i) => (
            <option key={i.id} value={i.id}>
              {pick(i)}
            </option>
          ))}
      </select>
      <input className="input num" inputMode="decimal" placeholder={t('qty')} value={line.qty} onChange={(e) => onChange({ ...line, qty: e.target.value })} disabled={!item} aria-label={t('qty')} />
      <select className="select" value={line.unit} onChange={(e) => onChange({ ...line, unit: e.target.value })} disabled={!item} aria-label={t('in')}>
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.label}
          </option>
        ))}
      </select>
      <button type="button" className="icon-btn" onClick={onRemove} disabled={!onRemove} aria-label={t('cancel')}>
        <IconX />
      </button>
    </div>
  );
}
