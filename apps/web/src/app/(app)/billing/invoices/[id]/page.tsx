'use client';

import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { PageHead } from '@/components/ui';
import { useI18n, type TKey } from '@/lib/i18n';
import { useApi } from '@/lib/session';

interface Party {
  name: string;
  nameAr?: string | null;
  vatNumber?: string | null;
  crNumber?: string | null;
  address?: string | Record<string, string>;
}
interface Invoice {
  id: string;
  number: string;
  status: string;
  interval: string;
  periodStart: string;
  periodEnd: string;
  issuedAt: string;
  paidAt: string | null;
  lines: { code: string; description: string; descriptionAr: string; quantity: number; unitPrice: string; amount: string }[];
  subtotal: string;
  vat: string;
  total: string;
  seller: Party;
  buyer: Party;
  qr: string;
}

/** BOH's tax invoice to the customer, printable, with the ZATCA phase-1 QR. */
export default function InvoicePage() {
  const { id } = useParams<{ id: string }>();
  const { t, lang, fmtMoney, fmtDate } = useI18n();
  const { data: inv } = useApi<Invoice>(`/billing/invoices/${id}`, [id]);
  const [qrSvg, setQrSvg] = useState<string>('');
  useEffect(() => {
    if (inv) QRCode.toString(inv.qr, { type: 'svg', margin: 1, width: 148, errorCorrectionLevel: 'M' }).then(setQrSvg);
  }, [inv]);
  if (!inv) return <div className="muted">{t('loading')}</div>;
  const ar = lang === 'ar';
  const addr = (p: Party) => (typeof p.address === 'string' ? p.address : Object.values(p.address ?? {}).filter(Boolean).join(' · '));
  const party = (title: string, p: Party) => (
    <div>
      <div className="faint" style={{ fontSize: 12 }}>
        {title}
      </div>
      <div style={{ fontWeight: 600 }}>{ar ? (p.nameAr ?? p.name) : p.name}</div>
      {p.vatNumber && (
        <div className="num" style={{ fontSize: 13 }}>
          {t('vatNumber')}: <bdi>{p.vatNumber}</bdi>
        </div>
      )}
      {p.crNumber && (
        <div className="num" style={{ fontSize: 13 }}>
          {t('crNumber')}: <bdi>{p.crNumber}</bdi>
        </div>
      )}
      {addr(p) && <div className="faint" style={{ fontSize: 13 }}>{addr(p)}</div>}
    </div>
  );

  return (
    <div className="page">
      <PageHead
        title={`${t('taxInvoice')} ${inv.number}`}
        sub={`${t('issued')} ${fmtDate(inv.issuedAt)} · ${t('period')} ${fmtDate(inv.periodStart)} – ${fmtDate(inv.periodEnd)}`}
        action={
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className={`tag ${inv.status === 'paid' ? 'tag-accent' : inv.status === 'failed' ? 'tag-late' : ''}`}>{t(`inv_${inv.status}` as TKey)}</span>
            <button className="btn btn-quiet no-print" onClick={() => window.print()}>
              {t('print')}
            </button>
          </div>
        }
      />
      <section className="card invoice-card">
        <div className="invoice-parties">
          {party(t('seller'), inv.seller)}
          {party(t('buyer'), inv.buyer)}
          <div className="invoice-qr" aria-label="ZATCA QR" dangerouslySetInnerHTML={{ __html: qrSvg }} />
        </div>
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('name')}</th>
                <th className="end">{t('qty')}</th>
                <th className="end hide-phone">{t('unitPrice')}</th>
                <th className="end">{t('lineTotal')}</th>
              </tr>
            </thead>
            <tbody>
              {inv.lines.map((l) => (
                <tr key={l.code}>
                  <td>{ar ? l.descriptionAr : l.description}</td>
                  <td className="end num">{l.quantity}</td>
                  <td className="end num hide-phone">{fmtMoney(l.unitPrice)}</td>
                  <td className="end num">{fmtMoney(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="totals">
          <span className="muted">{t('subtotal')}</span>
          <span className="num">{fmtMoney(inv.subtotal)}</span>
          <span className="muted">{t('vat')} 15%</span>
          <span className="num">{fmtMoney(inv.vat)}</span>
          <strong>{t('total')}</strong>
          <strong className="num">{fmtMoney(inv.total)}</strong>
        </div>
        <p className="faint" style={{ fontSize: 12, margin: 0 }}>
          {t('simplifiedNote')}
        </p>
      </section>
    </div>
  );
}
