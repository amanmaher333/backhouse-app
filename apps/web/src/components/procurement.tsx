'use client';

import { useI18n, type TKey } from '@/lib/i18n';
import type { PoStatus } from '@/lib/types-procurement';

export function PoStatusTag({ status }: { status: PoStatus }) {
  const { t } = useI18n();
  const tone = status === 'pending_approval' ? 'tag-late' : ['approved', 'sent', 'partially_received'].includes(status) ? 'tag-accent' : '';
  return (
    <span className={`tag ${tone}`}>
      <span className="dot" />
      {t(`po_${status}` as TKey)}
    </span>
  );
}
