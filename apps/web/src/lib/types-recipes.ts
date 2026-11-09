/* Recipes and costing (Phase 5). */

export type CostBasis = 'supplier' | 'average';

export interface RecipeSummary {
  price: string | null;
  priceSource: 'recipe' | 'pos' | null;
  priceExVat: string | null;
  batchCost?: string;
  unitCost?: string;
  foodCostPct?: string | null;
  overTarget?: boolean;
  missing: string[];
  cycle: boolean;
  allergens: string[];
  posProduct: { id: string; name: string; nameAr: string | null } | null;
}

export interface RecipeRow extends RecipeSummary {
  id: string;
  name: string;
  nameAr: string | null;
  kind: 'menu' | 'prep';
  category: string | null;
  yieldQty: string;
  yieldUnit: string;
  targetCostPct: string | null;
  source: string;
  lines: number;
}

export interface RecipeLineView {
  id: string;
  itemId: string | null;
  subRecipeId: string | null;
  name: string;
  nameAr: string | null;
  baseUnit: string | null;
  packs: { id: string; name: string; nameAr: string | null }[];
  qty: string;
  unit: string | null;
  packId: string | null;
  yieldPct: string;
  note: string | null;
  qtyBase: string | null;
  grossBase: string | null;
  unitCost?: string | null;
  cost?: string | null;
  problem: 'no_cost' | 'bad_unit' | 'missing' | 'cycle' | null;
}

export interface RecipeDetail extends RecipeSummary {
  id: string;
  name: string;
  nameAr: string | null;
  kind: 'menu' | 'prep';
  category: string | null;
  yieldQty: string;
  yieldUnit: string;
  sellingPrice: string | null;
  priceIncludesVat: boolean;
  targetCostPct: string | null;
  posProductId: string | null;
  notes: string | null;
  source: string;
  usedIn: { id: string; name: string; nameAr: string | null }[];
  lines: RecipeLineView[];
}

export interface PosProductOption {
  id: string;
  name: string;
  nameAr: string | null;
  price: string | null;
  category: string | null;
  hasPosRecipe: boolean;
}
