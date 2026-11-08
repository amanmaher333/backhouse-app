/**
 * Text normalisation for matching messy item names across Arabic and English,
 * e.g. "Tomato Rnd 1KG Jordan", "طماطم  ١ كجم", "TOMATOES (CTN 6KG)".
 *
 * The goal is a stable comparison key, not something to show users.
 */

const ARABIC_DIACRITICS = /[ً-ٰٟۖ-ۭ]/g; // tashkeel, superscript alef, Quranic marks
const TATWEEL = /ـ/g;
const ARABIC_INDIC_DIGITS = /[٠-٩]/g;
const PERSIAN_DIGITS = /[۰-۹]/g;

/** Units and packaging words that describe the pack, not the product. */
const PACK_WORDS = [
  // English
  'kg', 'kgs', 'kilo', 'kilos', 'g', 'gm', 'gms', 'gr', 'grm', 'gram', 'grams', 'mg', 'ml', 'l', 'lt', 'ltr', 'ltrs', 'litre', 'liter', 'litres', 'liters', 'cl',
  'oz', 'lb', 'lbs', 'pc', 'pcs', 'piece', 'pieces', 'pkt', 'pkts', 'pack', 'packs', 'box', 'boxes', 'bx', 'ctn', 'ctns', 'carton', 'cartons', 'case', 'cs',
  'tray', 'bag', 'bags', 'btl', 'bottle', 'bottles', 'can', 'cans', 'tin', 'tins', 'jar', 'jars', 'tub', 'bucket', 'roll', 'rolls', 'doz', 'dozen', 'each', 'ea', 'x', 'nos',
  // Arabic (already letter-normalised: ة→ه, أ→ا, ى→ي)
  'كجم', 'كغ', 'كيلو', 'كيلوجرام', 'جم', 'جرام', 'غرام', 'غ', 'مل', 'ملي', 'لتر', 'لترات', 'حبه', 'حبات', 'قطعه', 'قطع', 'كرتون', 'كراتين', 'علبه', 'علب',
  'كيس', 'اكياس', 'صندوق', 'صناديق', 'عبوه', 'عبوات', 'زجاجه', 'درزن', 'طبق', 'سطل', 'لفه',
];
const PACK_WORD_SET = new Set(PACK_WORDS);

/** Normalise Arabic letter variants so spelling differences don't matter. */
export function normalizeArabic(s: string): string {
  return s
    .replace(ARABIC_DIACRITICS, '')
    .replace(TATWEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي');
}

function toLatinDigits(s: string): string {
  return s
    .replace(ARABIC_INDIC_DIGITS, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(PERSIAN_DIGITS, (d) => String(d.charCodeAt(0) - 0x06f0));
}

/**
 * Comparison key for an item name: lower-case, Arabic letters unified, digits
 * Latin, punctuation removed, and pack-size tokens ("1kg", "6x1L", "كرتون") dropped.
 */
export function normalizeName(input: string): string {
  let s = toLatinDigits(normalizeArabic(input.normalize('NFKC').toLowerCase()));
  // Arabic decimal separator and comma → spaces/dots
  s = s.replace(/[٫]/g, '.').replace(/[،؛]/g, ' ');
  // Split glued number+unit ("1kg", "6x1l", "500ml", "1كجم") into tokens
  s = s.replace(/(\d)([a-z؀-ۿ])/g, '$1 $2').replace(/([a-z؀-ۿ])(\d)/g, '$1 $2');
  // Punctuation → space (keep letters, digits, spaces)
  s = s.replace(/[^\p{L}\p{N}\s]/gu, ' ');
  const tokens = s
    .split(/\s+/)
    .filter(Boolean)
    .filter((t) => !/^\d+(\.\d+)?$/.test(t)) // bare numbers are pack sizes
    .filter((t) => !PACK_WORD_SET.has(t));
  return tokens.join(' ').trim();
}

/** True if the string contains Arabic letters. */
export function hasArabic(s: string): boolean {
  return /[؀-ۿ]/.test(s);
}
