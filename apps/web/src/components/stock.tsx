'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo } from 'react';
import { unitLabel, unitsFor } from '@/components/counts';
import { useI18n, type TKey } from '@/lib/i18n';
import type { StockItem, TransferStatus } from '@/lib/types-stock';

/** Tabs across the stock pages: on hand, counts, waste, transfers. */
export function StockTabs() {
  const { t } = useI18n();
  const path = usePathname();
  const tabs: { href: string; label: TKey }[] = [
    { href: '/stock', label: 'stockTab' },
    { href: '/stock/counts', label: 'counts' },
    { href: '/stock/waste', label: 'waste' },
    { href: '/stock/transfers', label: 'transfers' },
  ];
  const active = [...tabs].reverse().find((x) => path === x.href || path.startsWith(`${x.href}/`))?.href;
  return (
    <nav className="segmented stock-tabs" aria-label={t('stock')}>
      {tabs.map((x) => (
        <Link key={x.href} href={x.href} aria-current={active === x.href ? 'page' : undefined} className={active === x.href ? 'on' : ''}>
          {t(x.label)}
        </Link>
      ))}
    </nav>
  );
}

export function TransferStatusTag({ status }: { status: TransferStatus }) {
  const { t } = useI18n();
  const tone = status === 'sent' ? 'tag-late' : status === 'received' ? 'tag-accent' : '';
  return (
    <span className={`tag ${tone}`}>
      <span className="dot" />
      {t(`transfer_${status}` as TKey)}
    </span>
  );
}

/** Unit and pack choices for an item, as "unit:kg" / "pack:<id>" keys. */
export function useQtyOptions(item: Pick<StockItem, 'baseUnit' | 'packs'> | undefined) {
  const { lang } = useI18n();
  return useMemo(
    () =>
      item
        ? [
            ...item.packs.map((p) => ({ key: `pack:${p.id}`, label: lang === 'ar' && p.nameAr ? p.nameAr : p.name })),
            ...unitsFor(item.baseUnit).map((u) => ({ key: `unit:${u}`, label: unitLabel(u, lang) })),
          ]
        : [],
    [item, lang],
  );
}

/** "unit:kg" → { unit: 'kg' }, "pack:<id>" → { packId }. */
export function qtyRef(key: string): { unit?: string; packId?: string } {
  const [kind, ref] = key.split(':');
  return kind === 'pack' ? { packId: ref } : { unit: ref };
}

/** Arabic-Indic digits and the Arabic decimal point to a number. */
export function readNumber(s: string): number {
  return Number(s.trim().replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660)).replace('٫', '.'));
}

/** The quantity someone entered, e.g. "2 Carton 10 kg" or "3 kg". */
export function useEntryLabel() {
  const { lang } = useI18n();
  return (entryQty: string, entryUnit: string | null, entryPackId: string | null, packs: { id: string; name: string; nameAr: string | null }[], baseUnit: string) => {
    const pack = packs.find((p) => p.id === entryPackId);
    return `${Number(entryQty)} ${pack ? (lang === 'ar' && pack.nameAr ? pack.nameAr : pack.name) : unitLabel(entryUnit ?? baseUnit, lang)}`;
  };
}
