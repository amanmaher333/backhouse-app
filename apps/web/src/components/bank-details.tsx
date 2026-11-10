'use client';

import { useI18n } from '@/lib/i18n';

/** Kitchain's bank account for transfers (or a note that the details will be sent). Shared with the invoice page. */
export function BankDetails({ bank, reference }: { bank: { bankName: string | null; accountName: string; iban: string } | null; reference?: string }) {
  const { t } = useI18n();
  if (!bank) return <p className="faint" style={{ margin: 0, fontSize: 14 }}>{t('bankDetailsSoon')}</p>;
  const row = (label: string, value: string) => (
    <>
      <dt className="muted">{label}</dt>
      <dd className="num" style={{ margin: 0, fontWeight: 500 }} dir="ltr">{value}</dd>
    </>
  );
  return (
    <dl className="bank-details">
      {bank.bankName && row(t('bankName'), bank.bankName)}
      {row(t('accountName'), bank.accountName)}
      {row(t('iban'), bank.iban.replace(/(.{4})/g, '$1 ').trim())}
      {reference && row(t('transferReference'), reference)}
    </dl>
  );
}
