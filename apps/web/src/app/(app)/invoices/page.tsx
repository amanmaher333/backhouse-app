'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { Empty, PageHead } from '@/components/ui';
import { IconPlus } from '@/components/icons';
import { InvoiceStatusTag, UploadDialog } from '@/components/invoices';
import { useI18n, type TKey } from '@/lib/i18n';
import { useApi, useSession } from '@/lib/session';
import type { InvoiceRow } from '@/lib/types-invoices';

type Tab = 'review' | 'matched' | 'disputed' | 'to_pay' | 'all';
const TABS: { key: Tab; label: TKey; count?: 'review' | 'matched' | 'disputed' | 'toPay' }[] = [
  { key: 'review', label: 'tabReview', count: 'review' },
  { key: 'matched', label: 'tabMatched', count: 'matched' },
  { key: 'disputed', label: 'tabDisputed', count: 'disputed' },
  { key: 'to_pay', label: 'tabToPay', count: 'toPay' },
  { key: 'all', label: 'tabAll' },
];

export default function InvoicesPage() {
  const { t, pick, fmtMoney, fmtDate } = useI18n();
  const { can } = useSession();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>('review');
  const [uploading, setUploading] = useState(false);
  const [copied, setCopied] = useState(false);
  const { data: rows } = useApi<InvoiceRow[]>(`/supplier-invoices?status=${tab}`, [tab]);
  const { data: counts } = useApi<{ review: number; matched: number; disputed: number; toPay: number }>('/supplier-invoices/counts', [tab]);
  const { data: inbox } = useApi<{ address: string; enabled: boolean; readsAutomatically: boolean }>(can('invoice:manage') ? '/supplier-invoices/inbox' : null);

  return (
    <div className="page">
      <PageHead
        title={t('invoices')}
        sub={t('invoicesSub')}
        action={
          can('invoice:manage') && (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <Link className="btn btn-quiet" href="/invoices/new">
                {t('enterByHand')}
              </Link>
              <button className="btn btn-primary" onClick={() => setUploading(true)}>
                <IconPlus /> {t('addInvoice')}
              </button>
            </div>
          )
        }
      />

      {inbox && (
        <section className="card" style={{ gap: 8 }}>
          {inbox.enabled ? (
            <>
              <div className="muted" style={{ fontSize: 13 }}>
                {t('emailIn')}
              </div>
              <div className="copy-row">
                <code dir="ltr">{inbox.address}</code>
                <button
                  className="btn btn-sm btn-quiet"
                  onClick={() => {
                    navigator.clipboard?.writeText(inbox.address).then(() => {
                      setCopied(true);
                      setTimeout(() => setCopied(false), 1500);
                    });
                  }}
                >
                  {copied ? t('copied') : t('copy')}
                </button>
              </div>
              <div className="faint" style={{ fontSize: 12 }}>
                {t('emailInHint')}
              </div>
            </>
          ) : (
            <div className="faint" style={{ fontSize: 13 }}>
              {t('emailOff')}
            </div>
          )}
        </section>
      )}

      <div className="filters">
        <div className="segmented" role="group" style={{ overflowX: 'auto', maxWidth: '100%' }}>
          {TABS.map((x) => (
            <button key={x.key} aria-pressed={tab === x.key} onClick={() => setTab(x.key)}>
              {t(x.label)}
              {x.count && counts && counts[x.count] > 0 && <span className="num"> {counts[x.count]}</span>}
            </button>
          ))}
        </div>
      </div>

      {rows && rows.length === 0 ? (
        <div className="card">
          <Empty title={t('noInvoices')} body={t('noInvoicesBody')} />
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>{t('invoice')}</th>
                <th>{t('supplier')}</th>
                <th className="hide-phone">{t('site')}</th>
                <th className="hide-phone">{t('issueDate')}</th>
                <th className="end">{t('total')}</th>
                <th>{t('status')}</th>
              </tr>
            </thead>
            <tbody>
              {rows?.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/invoices/${r.id}`} style={{ fontWeight: 600 }} className="num">
                      <bdi>{r.number ?? r.ref}</bdi>
                    </Link>
                    <div className="faint num" style={{ fontSize: 12 }}>
                      {r.type !== 'invoice' ? `${t(r.type === 'credit_note' ? 'creditNote' : 'debitNote')} · ` : ''}
                      {[r.number ? r.ref : null, r.poNumber].filter(Boolean).join(' · ')}
                    </div>
                  </td>
                  <td>{r.supplierName ? pick({ name: r.supplierName, nameAr: r.supplierNameAr }) : <span className="faint">{r.supplierNameOnInvoice ?? '–'}</span>}</td>
                  <td className="hide-phone muted">{r.siteName ? pick({ name: r.siteName, nameAr: r.siteNameAr }) : '–'}</td>
                  <td className="hide-phone num">{r.issueDate ? fmtDate(r.issueDate) : '–'}</td>
                  <td className="end num">
                    {r.total ? fmtMoney(r.total) : '–'}
                    {Number(r.claimTotal) > 0 && ['mismatch', 'disputed'].includes(r.status) && (
                      <div className="cell-flag" style={{ fontSize: 12 }}>
                        {fmtMoney(r.claimTotal)} {t('over')}
                      </div>
                    )}
                  </td>
                  <td>
                    <InvoiceStatusTag status={r.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {uploading && (
        <UploadDialog
          readsAutomatically={!!inbox?.readsAutomatically}
          onClose={() => setUploading(false)}
          onDone={(inv) => {
            setUploading(false);
            router.push(`/invoices/${inv.id}${inv.duplicateUpload ? '?dup=1' : ''}`);
          }}
        />
      )}
    </div>
  );
}
