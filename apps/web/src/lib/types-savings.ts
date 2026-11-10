export type SavingKind = 'credit_note' | 'duplicate' | 'supplier_switch' | 'claim_open';

export interface SavingRow {
  kind: SavingKind;
  date: string;
  amount: string;
  supplier: { name: string; nameAr: string } | null;
  subject: { type: 'invoice' | 'item'; id: string; label: string; labelAr: string };
  detail?: { claim?: string; creditNote?: string; credited?: string; spend?: string; savingPct?: number; switchedOn?: string };
}

export interface SavingsReport {
  period: { from: string; to: string };
  today: string;
  currency: string;
  totals: {
    saved: string;
    inProgress: string;
    byKind: Record<SavingKind, { amount: string; count: number }>;
    cost: string;
    multiple: number | null;
    planMonthly: string | null;
  };
  trial: { startedOn: string; endsOn: string; daysLeft: number; saved: string; monthlyPrice: string; multiple: number | null } | null;
  entries: SavingRow[];
}
