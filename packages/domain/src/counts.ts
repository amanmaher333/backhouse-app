import { Decimal } from 'decimal.js';
import { normalizeArabic, normalizeName } from './text.js';

/*
 * Stock counts: reading what someone typed or said ("tomatoes 12 kg, chicken
 * 3 cartons", "طماطم ١٢ كيلو، دجاج ٣ كراتين") into items and quantities, and
 * the variance maths. Pure: the caller supplies the site's items and packs.
 */

export interface CountableItem {
  id: string;
  name: string;
  nameAr?: string | null;
  code?: string | null;
  baseUnit: string;
  packs: { id: string; name: string; nameAr?: string | null; isCountable?: boolean }[];
}

export interface ParsedEntry {
  /** The piece of text this came from. */
  raw: string;
  itemId: string | null;
  /** When the item is unclear: the closest items, best first. */
  candidates: string[];
  qty: string | null;
  unit: string | null;
  packId: string | null;
  /** What's missing: no quantity, item not recognised, or no unit we can use. */
  problem: 'no_qty' | 'no_item' | 'ambiguous_item' | 'no_unit' | null;
}

/** Spoken and written unit words (English and Arabic, already letter-normalised) → unit code. */
const UNIT_WORDS: Record<string, string> = {
  kg: 'kg', kgs: 'kg', kilo: 'kg', kilos: 'kg', kilogram: 'kg', kilograms: 'kg', كيلو: 'kg', كيلوات: 'kg', كجم: 'kg', كغ: 'kg', كيلوجرام: 'kg', كيلوغرام: 'kg',
  g: 'g', gm: 'g', gms: 'g', gr: 'g', gram: 'g', grams: 'g', جرام: 'g', غرام: 'g', جم: 'g', غ: 'g',
  l: 'l', lt: 'l', ltr: 'l', ltrs: 'l', litre: 'l', litres: 'l', liter: 'l', liters: 'l', لتر: 'l', لترات: 'l',
  ml: 'ml', مل: 'ml', ملي: 'ml',
  each: 'each', ea: 'each', pc: 'each', pcs: 'each', piece: 'each', pieces: 'each', حبه: 'each', حبات: 'each', قطعه: 'each', قطع: 'each',
  dozen: 'dozen', doz: 'dozen', درزن: 'dozen', دزينه: 'dozen',
};

/** Pack words → the words a pack's name may contain. */
const PACK_WORDS: Record<string, string[]> = {
  carton: ['carton', 'ctn', 'كرتون'], cartons: ['carton', 'ctn', 'كرتون'], ctn: ['carton', 'ctn', 'كرتون'], ctns: ['carton', 'ctn', 'كرتون'], كرتون: ['carton', 'ctn', 'كرتون'], كراتين: ['carton', 'ctn', 'كرتون'],
  box: ['box', 'علبه', 'صندوق'], boxes: ['box', 'علبه', 'صندوق'], علبه: ['box', 'علبه', 'pack'], علب: ['box', 'علبه', 'pack'], صندوق: ['box', 'صندوق', 'case'], صناديق: ['box', 'صندوق', 'case'],
  case: ['case', 'صندوق'], cases: ['case', 'صندوق'],
  bag: ['bag', 'sack', 'كيس'], bags: ['bag', 'sack', 'كيس'], sack: ['sack', 'bag', 'كيس'], sacks: ['sack', 'bag', 'كيس'], كيس: ['bag', 'sack', 'كيس'], اكياس: ['bag', 'sack', 'كيس'],
  tray: ['tray', 'طبق'], trays: ['tray', 'طبق'], طبق: ['tray', 'طبق'], اطباق: ['tray', 'طبق'],
  bottle: ['bottle', 'btl', 'زجاجه', 'قاروره'], bottles: ['bottle', 'btl', 'زجاجه', 'قاروره'], زجاجه: ['bottle', 'زجاجه'], قاروره: ['bottle', 'قاروره'],
  tin: ['tin', 'can', 'تنكه', 'علبه'], tins: ['tin', 'can', 'تنكه'], can: ['can', 'tin', 'علبه'], cans: ['can', 'tin', 'علبه'], تنكه: ['tin', 'تنكه'],
  pack: ['pack', 'pkt', 'باكيت', 'علبه'], packs: ['pack', 'pkt', 'باكيت'], باكيت: ['pack', 'باكيت'],
  bucket: ['bucket', 'سطل'], سطل: ['bucket', 'سطل'],
  roll: ['roll', 'لفه'], rolls: ['roll', 'لفه'], لفه: ['roll', 'لفه'],
};

/** Arabic-Indic (٠-٩) and Persian (۰-۹) digits to Latin, and the Arabic decimal separator to a dot. */
const toLatin = (s: string) =>
  s
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/٫/g, '.');

/** Small number words people say instead of digits. */
const NUMBER_WORDS: Record<string, string> = {
  half: '0.5', نص: '0.5', نصف: '0.5', one: '1', واحد: '1', two: '2', اثنين: '2', ثنين: '2', three: '3', ثلاث: '3', ثلاثه: '3', four: '4', اربع: '4', اربعه: '4',
  five: '5', خمس: '5', خمسه: '5', six: '6', ست: '6', سته: '6', seven: '7', سبع: '7', سبعه: '7', eight: '8', ثمان: '8', ثمانيه: '8', nine: '9', تسع: '9', تسعه: '9', ten: '10', عشر: '10', عشره: '10',
};

/** Same word, allowing plurals and short suffixes ("tomato" / "tomatoes"). */
const sameWord = (x: string, y: string) => x === y || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)) && Math.abs(x.length - y.length) <= 2);
const words = (s: string | null | undefined) => normalizeName(s ?? '').split(' ').filter((t) => t.length > 1);
/** Every word of a pack name, pack words included ("Carton 10 kg" → carton, kg). */
const packWords = (s: string | null | undefined) => normalizeArabic((s ?? '').toLowerCase()).split(/[^\p{L}]+/u).filter(Boolean);

function similarity(said: string[], name: string[]): number {
  if (!said.length || !name.length) return 0;
  const hits = said.filter((t) => name.some((u) => sameWord(t, u))).length;
  // How much of what was said matched, weighted towards covering the item's name.
  return (hits / said.length) * 0.6 + (hits / name.length) * 0.4;
}

/**
 * Split a message into one entry per item: new lines, commas (Latin and Arabic) and
 * semicolons; also "and"/"و" once the part before it has a quantity, so names like
 * "salt and pepper" stay whole.
 */
export function splitEntries(text: string): string[] {
  const out: string[] = [];
  for (const part of toLatin(text).split(/[\n,،;؛]+/)) {
    let current = '';
    for (const piece of part.split(/(\s+(?:and|و)\s+)/i)) {
      if (/^\s+(?:and|و)\s+$/i.test(piece) && /\d/.test(current)) {
        out.push(current.trim());
        current = '';
      } else current += piece;
    }
    if (current.trim()) out.push(current.trim());
  }
  return out.filter(Boolean);
}

/** Read one entry against the site's items. */
export function parseEntry(raw: string, items: CountableItem[]): ParsedEntry {
  const text = normalizeArabic(toLatin(raw).toLowerCase());
  // Separate digits glued to words ("12kg", "3كراتين").
  const spaced = text.replace(/(\d)([^\d\s.])/g, '$1 $2').replace(/([^\d\s.])(\d)/g, '$1 $2');
  const tokens = spaced.split(/\s+/).filter(Boolean);
  let qty: string | null = null;
  let unitWord: string | null = null;
  let packWord: string | null = null;
  const rest: string[] = [];
  for (const t of tokens) {
    const clean = t.replace(/^[^\p{L}\p{N}.]+|[^\p{L}\p{N}.]+$/gu, '');
    if (!clean) continue;
    if (qty === null && /^\d+(\.\d+)?$/.test(clean)) qty = new Decimal(clean).toString();
    else if (qty === null && NUMBER_WORDS[clean]) qty = NUMBER_WORDS[clean]!;
    else if (!unitWord && !packWord && UNIT_WORDS[clean]) unitWord = UNIT_WORDS[clean]!;
    else if (!unitWord && !packWord && PACK_WORDS[clean]) packWord = clean;
    else rest.push(clean);
  }
  const said = words(rest.join(' '));
  const scored = items
    .map((it) => ({ it, score: Math.max(similarity(said, words(it.name)), similarity(said, words(it.nameAr)), it.code && rest.includes(it.code.toLowerCase()) ? 1 : 0) }))
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  const clear = best && (scored.length === 1 || best.score - scored[1]!.score >= 0.15);
  const base: ParsedEntry = { raw, itemId: null, candidates: scored.slice(0, 3).map((x) => x.it.id), qty, unit: null, packId: null, problem: null };
  if (!best) return { ...base, problem: 'no_item' };
  if (!clear) return { ...base, problem: 'ambiguous_item' };
  const item = best.it;
  const out: ParsedEntry = { ...base, itemId: item.id, candidates: [] };
  if (qty === null) return { ...out, problem: 'no_qty' };
  const countable = item.packs.filter((p) => p.isCountable !== false);
  if (packWord) {
    const wanted = PACK_WORDS[packWord]!;
    const pack = countable.find((p) => [p.name, p.nameAr].some((n) => n && packWords(n).some((w) => wanted.some((x) => sameWord(w, normalizeArabic(x))))));
    return pack ? { ...out, packId: pack.id } : { ...out, problem: 'no_unit' };
  }
  if (unitWord) {
    const dims: Record<string, string> = { kg: 'g', g: 'g', l: 'ml', ml: 'ml', each: 'each', dozen: 'each' };
    return dims[unitWord] === item.baseUnit ? { ...out, unit: unitWord } : { ...out, problem: 'no_unit' };
  }
  // No unit said: "eggs 30" means 30 of them when the item is counted in each; one countable pack is also clear.
  if (item.baseUnit === 'each') return { ...out, unit: 'each' };
  if (countable.length === 1) return { ...out, packId: countable[0]!.id };
  return { ...out, problem: 'no_unit' };
}

export function parseCountText(text: string, items: CountableItem[]): ParsedEntry[] {
  return splitEntries(text).map((e) => parseEntry(e, items));
}

/**
 * What a counted line changes. Expected = the quantity when the line's count
 * started plus everything that moved since (deliveries, transfers, waste) up to
 * the moment it was counted; the adjustment brings the ledger to the count.
 */
export function countAdjustment(p: { snapshotQty: Decimal.Value; movedSinceSnapshot: Decimal.Value; countedQty: Decimal.Value; unitCost: Decimal.Value }) {
  const expected = new Decimal(p.snapshotQty).plus(p.movedSinceSnapshot);
  const adjustment = new Decimal(p.countedQty).minus(expected);
  return { expected: expected.toFixed(6), adjustment: adjustment.toFixed(6), value: adjustment.mul(p.unitCost).toFixed(2) };
}
