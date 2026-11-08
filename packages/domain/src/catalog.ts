/** Catalogue constants shared by API and web. */

export const ITEM_CATEGORIES = [
  'produce',
  'meat',
  'poultry',
  'seafood',
  'dairy',
  'eggs',
  'bakery',
  'dry_goods',
  'grains',
  'oils_fats',
  'spices',
  'sauces',
  'beverages',
  'frozen',
  'packaging',
  'cleaning',
  'other',
] as const;
export type ItemCategory = (typeof ITEM_CATEGORIES)[number];

/** The 14 allergens food businesses commonly declare (EU/GCC style list). */
export const ALLERGENS = [
  'gluten',
  'crustaceans',
  'eggs',
  'fish',
  'peanuts',
  'soy',
  'milk',
  'tree_nuts',
  'celery',
  'mustard',
  'sesame',
  'sulphites',
  'lupin',
  'molluscs',
] as const;
export type Allergen = (typeof ALLERGENS)[number];

export const BASE_UNITS = ['g', 'ml', 'each'] as const;
export type BaseUnit = (typeof BASE_UNITS)[number];

export const ORDER_CHANNELS = ['email', 'whatsapp', 'portal', 'manual'] as const;
export type OrderChannel = (typeof ORDER_CHANNELS)[number];

/** Matching thresholds for linking a tenant item to the shared ingredient map. */
export const MATCH_AUTO_SCORE = 0.62;
export const MATCH_AUTO_MARGIN = 0.12;
export const MATCH_SUGGEST_SCORE = 0.25;

/** Percentage change from old to new (null when old is zero/missing). */
export function pctChange(oldValue: number | string | null | undefined, newValue: number | string): number | null {
  const o = Number(oldValue);
  const n = Number(newValue);
  if (!o || !Number.isFinite(o) || !Number.isFinite(n)) return null;
  return ((n - o) / o) * 100;
}
