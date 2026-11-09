'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { Field, PageHead } from '@/components/ui';
import { IconX } from '@/components/icons';
import { useI18n, type TKey } from '@/lib/i18n';
import { ApiError, useApi, useSession } from '@/lib/session';
import type { LegalEntity } from '@/lib/types';
import type { SaleDetail, SaleKind, SaleRow, SaleType } from '@/lib/types-sales';

interface L {
  name: string;
  qty: string;
  unitPrice: string;
  discount: string;
  vatCategory: 'S' | 'Z' | 'E' | 'O';
  exemptionCode: string;
}
const blank = (): L => ({ name: '', qty: '1', unitPrice: '', discount: '', vatCategory: 'S', exemptionCode: '' });
const round2 = (n: number) => Math.round(n * 100) / 100;

export default function NewSalePage() {
  return (
    <Suspense>
      <NewSale />
    </Suspense>
  );
}

function NewSale() {
  const { t, pick, fmtMoney } = useI18n();
  const { api } = useSession();
  const router = useRouter();
  const search = useSearchParams();
  const { data: entities } = useApi<LegalEntity[]>('/legal-entities');
  const [legalEntityId, setLegalEntityId] = useState('');
  const [kind, setKind] = useState<SaleKind>('standard');
  const [type, setType] = useState<SaleType>((search.get('type') as SaleType) || 'invoice');
  const [originalId, setOriginalId] = useState(search.get('original') ?? '');
  const [buyer, setBuyer] = useState({ name: '', vatNumber: '', street: '', building: '', district: '', city: '', postalCode: '' });
  const [lines, setLines] = useState<L[]>([blank()]);
  const [supplyDate, setSupplyDate] = useState(new Date().toISOString().slice(0, 10));
  const [paymentMeansCode, setPaymentMeansCode] = useState('30');
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { data: issued } = useApi<SaleRow[]>(type !== 'invoice' ? '/sales-invoices?status=all&limit=200' : null, [type]);
  const originals = (issued ?? []).filter((r) => r.type === 'invoice' && ['cleared', 'reported'].includes(r.status));

  useEffect(() => {
    if (entities?.length && !legalEntityId) setLegalEntityId(entities[0]!.id);
  }, [entities, legalEntityId]);
  // A note copies the invoice it corrects: company, kind and buyer.
  useEffect(() => {
    if (!originalId) return;
    api<SaleDetail>(`/sales-invoices/${originalId}`)
      .then((o) => {
        setLegalEntityId(o.legalEntityId);
        setKind(o.kind);
        if (o.buyer) setBuyer({ name: o.buyer.name ?? '', vatNumber: o.buyer.vatNumber ?? '', street: o.buyer.address?.street ?? '', building: o.buyer.address?.building ?? '', district: o.buyer.address?.district ?? '', city: o.buyer.address?.city ?? '', postalCode: o.buyer.address?.postalCode ?? '' });
      })
      .catch(() => {});
  }, [originalId, api]);

  const set = (i: number, patch: Partial<L>) => setLines(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const net = (l: L) => round2((Number(l.qty) || 0) * (Number(l.unitPrice) || 0) - (Number(l.discount) || 0));
  const subtotal = lines.reduce((s, l) => s + net(l), 0);
  const vat = round2(lines.filter((l) => l.vatCategory === 'S').reduce((s, l) => s + net(l), 0) * 0.15);

  const submit = async (issue: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const b = buyer.name.trim()
        ? { name: buyer.name.trim(), vatNumber: buyer.vatNumber.trim() || null, address: buyer.street ? { street: buyer.street, building: buyer.building, district: buyer.district, city: buyer.city, postalCode: buyer.postalCode } : null }
        : null;
      const inv = await api<SaleDetail>('/sales-invoices', {
        method: 'POST',
        body: {
          legalEntityId,
          kind,
          type,
          buyer: b,
          lines: lines.filter((l) => l.name.trim()).map((l) => ({ name: l.name.trim(), qty: Number(l.qty), unitPrice: Number(l.unitPrice), discount: Number(l.discount) || null, vatCategory: l.vatCategory, exemptionCode: l.vatCategory === 'S' ? null : l.exemptionCode || null })),
          supplyDate: kind === 'standard' ? supplyDate : null,
          paymentMeansCode,
          reason: type === 'invoice' ? null : reason,
          note: note || null,
          originalInvoiceId: type === 'invoice' ? null : originalId || null,
          issue,
        },
      });
      router.push(`/sales/${inv.id}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <PageHead title={type === 'invoice' ? t('newSalesInvoice') : t(`docType_${type}` as TKey)} sub={t(`kindHint_${kind}` as TKey)} />
      <section className="card">
        {error && <div className="notice notice-error">{error}</div>}
        <div className="form-grid">
          {entities && entities.length > 1 && (
            <Field label={t('company')}>
              <select className="select" value={legalEntityId} onChange={(e) => setLegalEntityId(e.target.value)} disabled={!!originalId}>
                {entities.map((e) => (
                  <option key={e.id} value={e.id}>
                    {pick(e)}
                  </option>
                ))}
              </select>
            </Field>
          )}
          <Field label={t('type')}>
            <select className="select" value={type} onChange={(e) => setType(e.target.value as SaleType)}>
              {(['invoice', 'credit_note', 'debit_note'] as const).map((x) => (
                <option key={x} value={x}>
                  {t(`docType_${x}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('kind_standard') + ' / ' + t('kind_simplified')}>
            <div className="segmented" role="group">
              {(['standard', 'simplified'] as const).map((k) => (
                <button key={k} type="button" aria-pressed={kind === k} onClick={() => setKind(k)} disabled={!!originalId && type !== 'invoice'}>
                  {t(`kind_${k}`)}
                </button>
              ))}
            </div>
          </Field>
          {type !== 'invoice' && (
            <>
              <Field label={t('originalInvoice')}>
                <select className="select" value={originalId} onChange={(e) => setOriginalId(e.target.value)}>
                  <option value="">–</option>
                  {originals.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.number} · {o.buyer?.name ?? ''} · {fmtMoney(o.total)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t('reasonForNote')}>
                <input className="input" value={reason} onChange={(e) => setReason(e.target.value)} />
              </Field>
            </>
          )}
        </div>

        <h2 className="card-title" style={{ marginTop: 8 }}>
          {t('buyer')}
        </h2>
        <div className="form-grid">
          <Field label={t('buyerName')} hint={kind === 'simplified' ? t('optional') : undefined}>
            <input className="input" value={buyer.name} onChange={(e) => setBuyer({ ...buyer, name: e.target.value })} />
          </Field>
          <Field label={t('buyerVat')} hint={kind === 'simplified' ? t('optional') : undefined}>
            <input className="input num" dir="ltr" inputMode="numeric" maxLength={15} value={buyer.vatNumber} onChange={(e) => setBuyer({ ...buyer, vatNumber: e.target.value.replace(/\D/g, '') })} />
          </Field>
          {kind === 'standard' &&
            (['street', 'building', 'district', 'city', 'postalCode'] as const).map((k) => (
              <Field key={k} label={t(k)}>
                <input className="input" dir={k === 'building' || k === 'postalCode' ? 'ltr' : undefined} inputMode={k === 'building' || k === 'postalCode' ? 'numeric' : undefined} value={buyer[k]} onChange={(e) => setBuyer({ ...buyer, [k]: e.target.value })} />
              </Field>
            ))}
        </div>

        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('item')}</th>
                <th className="end">{t('qty')}</th>
                <th className="end">{t('unitPriceEx')}</th>
                <th className="end hide-phone">{t('discount')}</th>
                <th>{t('vatCategory')}</th>
                <th className="end">{t('netAmount')}</th>
                <th aria-hidden />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <input className="input inline-input" style={{ minWidth: 150 }} value={l.name} onChange={(e) => set(i, { name: e.target.value })} aria-label={`${t('item')} ${i + 1}`} />
                  </td>
                  <td className="end">
                    <input className="input inline-input num" style={{ width: 70, textAlign: 'end' }} inputMode="decimal" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} aria-label={`${t('qty')} ${i + 1}`} />
                  </td>
                  <td className="end">
                    <input className="input inline-input num" style={{ width: 96, textAlign: 'end' }} inputMode="decimal" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} aria-label={`${t('unitPriceEx')} ${i + 1}`} />
                  </td>
                  <td className="end hide-phone">
                    <input className="input inline-input num" style={{ width: 80, textAlign: 'end' }} inputMode="decimal" value={l.discount} onChange={(e) => set(i, { discount: e.target.value })} aria-label={`${t('discount')} ${i + 1}`} />
                  </td>
                  <td>
                    <select className="select" value={l.vatCategory} onChange={(e) => set(i, { vatCategory: e.target.value as L['vatCategory'] })} aria-label={`${t('vatCategory')} ${i + 1}`} style={{ minWidth: 110 }}>
                      {(['S', 'Z', 'E', 'O'] as const).map((c) => (
                        <option key={c} value={c}>
                          {t(`vat_${c}`)}
                        </option>
                      ))}
                    </select>
                    {l.vatCategory !== 'S' && (
                      <input className="input inline-input" dir="ltr" placeholder="VATEX-SA-32" style={{ width: 130, marginTop: 4 }} value={l.exemptionCode} onChange={(e) => set(i, { exemptionCode: e.target.value })} aria-label={`${t('exemptionCode')} ${i + 1}`} />
                    )}
                  </td>
                  <td className="end num">{fmtMoney(net(l))}</td>
                  <td className="end">
                    <button className="icon-btn" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))} aria-label={`${t('remove')} ${i + 1}`}>
                      <IconX width={16} height={16} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <button className="link-btn" style={{ marginTop: 8 }} onClick={() => setLines([...lines, blank()])}>
            + {t('addLine')}
          </button>
        </div>
        <div className="totals">
          <span className="muted">{t('subtotal')}</span>
          <span className="num">{fmtMoney(subtotal)}</span>
          <span className="muted">{t('vat')}</span>
          <span className="num">{fmtMoney(vat)}</span>
          <strong>{t('totalWithVat')}</strong>
          <strong className="num">{fmtMoney(subtotal + vat)}</strong>
        </div>
        <div className="form-grid">
          {kind === 'standard' && (
            <Field label={t('supplyDate')}>
              <input className="input" type="date" value={supplyDate} onChange={(e) => setSupplyDate(e.target.value)} />
            </Field>
          )}
          <Field label={t('paymentMeans')}>
            <select className="select" value={paymentMeansCode} onChange={(e) => setPaymentMeansCode(e.target.value)}>
              {(['30', '10', '48', '42', '1'] as const).map((c) => (
                <option key={c} value={c}>
                  {t(`pm_${c}`)}
                </option>
              ))}
            </select>
          </Field>
          <Field label={t('notesForInvoice')} hint={t('optional')}>
            <input className="input" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" disabled={busy || !legalEntityId} onClick={() => submit(true)}>
            {t('issueNow')}
          </button>
          <button className="btn btn-quiet" disabled={busy || !legalEntityId} onClick={() => submit(false)}>
            {t('saveAsDraft')}
          </button>
        </div>
      </section>
    </div>
  );
}
