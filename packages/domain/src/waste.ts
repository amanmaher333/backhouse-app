import { normalizeArabic } from './text.js';
import { parseEntry, splitEntries, type CountableItem, type ParsedEntry } from './counts.js';

/*
 * Waste: why stock was thrown away, and reading "tomatoes 2 kg spoiled" /
 * "طماطم ٢ كيلو تالف" into item, quantity and reason.
 */

export const WASTE_REASONS = ['expired', 'spoiled', 'damaged', 'overproduction', 'prep_trim', 'dropped', 'returned', 'staff_meal', 'other'] as const;
export type WasteReason = (typeof WASTE_REASONS)[number];

/** Reason words (English, and Arabic already letter-normalised), including two-word phrases. */
const REASON_WORDS: [string, WasteReason][] = [
  ['out of date', 'expired'], ['past date', 'expired'], ['expired', 'expired'], ['expiry', 'expired'], ['منتهي الصلاحيه', 'expired'], ['منتهيه الصلاحيه', 'expired'], ['منتهي', 'expired'], ['منتهيه', 'expired'], ['انتهت', 'expired'],
  ['spoiled', 'spoiled'], ['spoilt', 'spoiled'], ['rotten', 'spoiled'], ['bad', 'spoiled'], ['mouldy', 'spoiled'], ['moldy', 'spoiled'], ['off', 'spoiled'], ['تالف', 'spoiled'], ['تالفه', 'spoiled'], ['خربان', 'spoiled'], ['خربانه', 'spoiled'], ['فاسد', 'spoiled'], ['فاسده', 'spoiled'], ['معفن', 'spoiled'],
  ['damaged', 'damaged'], ['broken', 'damaged'], ['crushed', 'damaged'], ['مكسور', 'damaged'], ['مكسوره', 'damaged'], ['متضرر', 'damaged'], ['مضروب', 'damaged'],
  ['overproduction', 'overproduction'], ['over production', 'overproduction'], ['leftover', 'overproduction'], ['leftovers', 'overproduction'], ['unsold', 'overproduction'], ['زياده', 'overproduction'], ['فايض', 'overproduction'], ['فائض', 'overproduction'], ['باقي', 'overproduction'],
  ['trim', 'prep_trim'], ['trimming', 'prep_trim'], ['trimmings', 'prep_trim'], ['peel', 'prep_trim'], ['peelings', 'prep_trim'], ['تنظيف', 'prep_trim'], ['قشر', 'prep_trim'],
  ['dropped', 'dropped'], ['spilled', 'dropped'], ['spilt', 'dropped'], ['طاح', 'dropped'], ['طايح', 'dropped'], ['انكب', 'dropped'], ['وقع', 'dropped'],
  ['returned', 'returned'], ['customer return', 'returned'], ['sent back', 'returned'], ['مرتجع', 'returned'], ['راجع', 'returned'],
  ['staff meal', 'staff_meal'], ['staff food', 'staff_meal'], ['وجبه موظفين', 'staff_meal'], ['اكل موظفين', 'staff_meal'],
];

export interface ParsedWaste extends ParsedEntry {
  reason: WasteReason | null;
}

/** Find a reason word in one entry and return the entry without it. */
export function takeReason(raw: string): { reason: WasteReason | null; rest: string } {
  const text = ` ${normalizeArabic(raw.toLowerCase())} `;
  // Longest phrases first, so "out of date" wins over "off" and "منتهي الصلاحيه" over "منتهي".
  for (const [w, reason] of [...REASON_WORDS].sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`(^|[\\s,،.(\\-–])${w.replace(/ /g, '\\s+')}(?=$|[\\s,،.)\\-–])`, 'u');
    if (re.test(text)) return { reason, rest: text.replace(re, '$1').replace(/\s+/g, ' ').trim() };
  }
  return { reason: null, rest: raw.trim() };
}

/**
 * Read a waste message: one entry per item, each with an optional reason. A reason
 * said once for the whole message ("expired: milk 2 l, yoghurt 6") applies to entries without their own.
 */
export function parseWasteText(text: string, items: CountableItem[]): ParsedWaste[] {
  let shared: WasteReason | null = null;
  const lead = text.match(/^\s*([^:：\n]{2,30})[:：]\s*/u);
  if (lead) {
    const r = takeReason(lead[1]!);
    if (r.reason && !r.rest) {
      shared = r.reason;
      text = text.slice(lead[0].length);
    }
  }
  return splitEntries(text).map((raw) => {
    const { reason, rest } = takeReason(raw);
    return { ...parseEntry(rest, items), raw, reason: reason ?? shared };
  });
}
