'use client';

import { useRef, useState } from 'react';
import { Dialog, Field } from '@/components/ui';
import { IconUpload, IconX } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { SupplierRow } from '@/lib/types';
import type { InvoiceDetail, InvoiceStatus, PoMatchLine } from '@/lib/types-invoices';

export function InvoiceStatusTag({ status }: { status: InvoiceStatus }) {
  const { t } = useI18n();
  const tone = ['mismatch', 'needs_review'].includes(status) ? 'tag-late' : ['matched', 'approved', 'paid'].includes(status) ? 'tag-accent' : '';
  return (
    <span className={`tag ${tone}`}>
      <span className="dot" />
      {t(`inv_${status}` as TKey)}
    </span>
  );
}

/** Open the original document in a new tab (the API needs the session token, so it is fetched first). */
export function useOpenDocument() {
  const { api } = useSession();
  return async (invoiceId: string) => {
    const tab = window.open('', '_blank');
    const blob = await api<Blob>(`/supplier-invoices/${invoiceId}/document`, { blob: true });
    const url = URL.createObjectURL(blob);
    if (tab) tab.location.href = url;
    else window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
}

const ACCEPT = '.pdf,.xml,.jpg,.jpeg,.png,.webp,application/pdf,application/xml,text/xml,image/jpeg,image/png,image/webp';

function contentTypeOf(f: File) {
  if (f.type) return f.type;
  if (/\.xml$/i.test(f.name)) return 'application/xml';
  if (/\.pdf$/i.test(f.name)) return 'application/pdf';
  return 'application/octet-stream';
}

async function toBase64(f: File) {
  const bytes = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function UploadDialog({ readsAutomatically, onClose, onDone }: { readsAutomatically: boolean; onClose: () => void; onDone: (inv: InvoiceDetail) => void }) {
  const { t, pick } = useI18n();
  const { api } = useSession();
  const { data: suppliers } = useApi<SupplierRow[]>('/suppliers');
  const [file, setFile] = useState<File | null>(null);
  const [relationshipId, setRelationshipId] = useState('');
  const [over, setOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const choose = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > 10 * 1024 * 1024) return setError(t('uploadHint'));
    setFile(f);
  };

  return (
    <Dialog
      title={t('uploadTitle')}
      onClose={onClose}
      actions={
        <>
          <button className="btn btn-quiet" onClick={onClose}>
            {t('cancel')}
          </button>
          <button
            className="btn btn-primary"
            disabled={!file || busy}
            onClick={async () => {
              if (!file) return;
              setBusy(true);
              setError(null);
              try {
                const inv = await api<InvoiceDetail>('/supplier-invoices/upload', {
                  method: 'POST',
                  body: { filename: file.name, contentType: contentTypeOf(file), data: await toBase64(file), relationshipId: relationshipId || null },
                });
                onDone(inv);
              } catch (e) {
                setError((e as ApiError).message);
                setBusy(false);
              }
            }}
          >
            {busy ? t('reading') : t('addInvoice')}
          </button>
        </>
      }
    >
      {error && <div className="notice notice-error">{error}</div>}
      <div
        className="dropzone"
        data-over={over}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          choose(e.dataTransfer.files[0]);
        }}
      >
        <IconUpload width={26} height={26} />
        {file ? (
          <strong style={{ overflowWrap: 'anywhere' }}>
            <bdi>{file.name}</bdi>
          </strong>
        ) : (
          <>
            <strong>{t('chooseFile')}</strong>
            <span className="faint">{t('dropHere')}</span>
          </>
        )}
        <span className="faint" style={{ fontSize: 12 }}>
          {t('uploadHint')}
        </span>
        <input ref={input} type="file" accept={ACCEPT} hidden onChange={(e) => choose(e.target.files?.[0])} />
      </div>
      <Field label={t('supplierOptional')}>
        <select className="select" value={relationshipId} onChange={(e) => setRelationshipId(e.target.value)}>
          <option value="">–</option>
          {suppliers?.map((s) => (
            <option key={s.id} value={s.id}>
              {pick({ name: s.displayName, nameAr: s.displayNameAr })}
            </option>
          ))}
        </select>
      </Field>
      <p className="faint" style={{ fontSize: 12, margin: 0 }}>
        {readsAutomatically ? t('readsAuto') : t('readsManual')}
      </p>
    </Dialog>
  );
}

export interface EditLine {
  description: string;
  sku: string;
  qty: string;
  unitPrice: string;
  poLineId: string;
}

export const emptyLine = (): EditLine => ({ description: '', sku: '', qty: '1', unitPrice: '', poLineId: '' });

/** Lines of an invoice being typed in or corrected, optionally paired with the order's lines. */
export function LinesEditor({ lines, onChange, poLines }: { lines: EditLine[]; onChange: (l: EditLine[]) => void; poLines?: PoMatchLine[] }) {
  const { t, pick, fmtMoney } = useI18n();
  const set = (i: number, patch: Partial<EditLine>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th>{t('description')}</th>
            <th className="hide-phone">{t('sku')}</th>
            <th className="end">{t('qty')}</th>
            <th className="end">{t('unitPrice')}</th>
            {poLines && <th className="hide-phone">{t('pairedWith')}</th>}
            <th className="end">{t('lineTotal')}</th>
            <th aria-hidden />
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td>
                <input className="input inline-input" value={l.description} onChange={(e) => set(i, { description: e.target.value })} aria-label={`${t('description')} ${i + 1}`} style={{ minWidth: 140 }} />
              </td>
              <td className="hide-phone">
                <input className="input inline-input" dir="ltr" value={l.sku} onChange={(e) => set(i, { sku: e.target.value })} aria-label={`${t('sku')} ${i + 1}`} style={{ width: 90 }} />
              </td>
              <td className="end">
                <input className="input inline-input num" inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label={`${t('qty')} ${i + 1}`} style={{ width: 72, textAlign: 'end' }} />
              </td>
              <td className="end">
                <input className="input inline-input num" inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} aria-label={`${t('unitPrice')} ${i + 1}`} style={{ width: 92, textAlign: 'end' }} />
              </td>
              {poLines && (
                <td className="hide-phone">
                  <select className="select" value={l.poLineId} onChange={(e) => set(i, { poLineId: e.target.value })} aria-label={`${t('pairedWith')} ${i + 1}`} style={{ minWidth: 130 }}>
                    <option value="">{t('auto')}</option>
                    {poLines.map((p) => (
                      <option key={p.id} value={p.id}>
                        {pick({ name: p.itemName, nameAr: p.itemNameAr })}
                      </option>
                    ))}
                  </select>
                </td>
              )}
              <td className="end num">{fmtMoney((Number(l.qty) || 0) * (Number(l.unitPrice) || 0))}</td>
              <td className="end">
                <button className="icon-btn" onClick={() => onChange(lines.filter((_, j) => j !== i))} aria-label={`${t('remove')} ${i + 1}`} disabled={lines.length === 1}>
                  <IconX width={16} height={16} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <button className="link-btn" style={{ marginTop: 8 }} onClick={() => onChange([...lines, emptyLine()])}>
        + {t('addLine')}
      </button>
    </div>
  );
}

export const toLineInput = (l: EditLine) => ({
  description: l.description.trim() || '—',
  sku: l.sku.trim() || null,
  qty: Number(l.qty) || 0,
  unitPrice: Number(l.unitPrice) || 0,
  poLineId: l.poLineId || null,
});
