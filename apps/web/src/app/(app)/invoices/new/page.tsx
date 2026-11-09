'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Field, PageHead } from '@/components/ui';
import { LinesEditor, emptyLine, toLineInput, type EditLine } from '@/components/invoices';
import { useI18n } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { SupplierRow } from '@/lib/types';
import type { PoDetail, PoRow } from '@/lib/types-procurement';
import type { InvoiceDetail } from '@/lib/types-invoices';

export default function NewInvoicePage() {
  const { t, pick, fmtMoney } = useI18n();
  const { api } = useSession();
  const router = useRouter();
  const { data: suppliers } = useApi<SupplierRow[]>('/suppliers');
  const [relationshipId, setRelationshipId] = useState('');
  const [poId, setPoId] = useState('');
  const [type, setType] = useState<'invoice' | 'credit_note'>('invoice');
  const [number, setNumber] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [lines, setLines] = useState<EditLine[]>([emptyLine()]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: orders } = useApi<PoRow[]>(relationshipId ? `/purchase-orders?status=all&relationshipId=${relationshipId}&limit=50` : null, [relationshipId]);
  const billable = orders?.filter((o) => ['sent', 'partially_received', 'received', 'closed'].includes(o.status)) ?? [];
  const subtotal = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);

  const fillFromOrder = async (id: string) => {
    const po = await api<PoDetail>(`/purchase-orders/${id}`);
    const received = po.lines.filter((l) => Number(l.receivedQty) > 0);
    setLines(
      (received.length ? received : po.lines).map((l) => ({
        description: pick({ name: l.itemName, nameAr: l.itemNameAr }),
        sku: l.supplierSku ?? '',
        qty: String(Number(received.length ? l.receivedQty : l.qty)),
        unitPrice: String(Number(l.unitPrice)),
        poLineId: '',
      })),
    );
  };

  const valid = relationshipId && number.trim() && issueDate && lines.some((l) => l.description.trim() && Number(l.qty) > 0);

  return (
    <div className="page">
      <PageHead title={t('enterInvoice')} sub={t('enterInvoiceSub')} />
      <section className="card">
        {error && <div className="notice notice-error">{error}</div>}
        <div className="form-grid">
          <Field label={t('supplier')}>
            <select
              className="select"
              value={relationshipId}
              onChange={(e) => {
                setRelationshipId(e.target.value);
                setPoId('');
              }}
            >
              <option value="">{t('pickSupplier')}</option>
              {suppliers?.map((s) => (
                <option key={s.id} value={s.id}>
                  {pick({ name: s.displayName, nameAr: s.displayNameAr })}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('type')}>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as 'invoice' | 'credit_note')}>
              <option value="invoice">{t('invoice')}</option>
              <option value="credit_note">{t('creditNote')}</option>
            </select>
          </Field>
          {type === 'invoice' && (
            <Field label={t('pickOrder')}>
              <select
                className="select"
                value={poId}
                disabled={!relationshipId}
                onChange={(e) => {
                  setPoId(e.target.value);
                  if (e.target.value) fillFromOrder(e.target.value).catch(() => {});
                }}
              >
                <option value="">–</option>
                {billable.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.number} · {pick({ name: o.siteName, nameAr: o.siteNameAr })} · {fmtMoney(o.total)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('invoiceNo')}>
            <input className="input" dir="ltr" value={number} onChange={(e) => setNumber(e.target.value)} />
          </Field>
          <Field label={t('issueDate')}>
            <input className="input" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
          </Field>
        </div>
        {poId && <p className="faint" style={{ fontSize: 12, margin: 0 }}>{t('fillFromOrder')}</p>}
        <LinesEditor lines={lines} onChange={setLines} />
        <div className="totals">
          <span className="muted">{t('subtotal')}</span>
          <span className="num">{fmtMoney(subtotal)}</span>
          <span className="muted">{t('vat')}</span>
          <span className="num">{fmtMoney(subtotal * 0.15)}</span>
          <strong>{t('total')}</strong>
          <strong className="num">{fmtMoney(subtotal * 1.15)}</strong>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-primary"
            disabled={!valid || busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                const inv = await api<InvoiceDetail>('/supplier-invoices', {
                  method: 'POST',
                  body: { type, relationshipId, poId: poId || null, number: number.trim(), issueDate, lines: lines.filter((l) => l.description.trim()).map(toLineInput) },
                });
                router.push(`/invoices/${inv.id}`);
              } catch (e) {
                setError((e as ApiError).message);
                setBusy(false);
              }
            }}
          >
            {t('createInvoice')}
          </button>
          <button className="btn btn-quiet" onClick={() => router.back()}>
            {t('cancel')}
          </button>
        </div>
      </section>
    </div>
  );
}
