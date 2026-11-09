/* Theoretical vs actual food cost (Phase 5). */

export interface FoodCostRow {
  itemId: string;
  name: string;
  nameAr: string | null;
  baseUnit: string;
  unitCost?: string | null;
  opening: string;
  received: string;
  transferIn: string;
  transferOut: string;
  closing: string;
  actual: string;
  sold: string;
  waste: string;
  theoretical: string;
  variance: string;
  actualValue?: string | null;
  theoreticalValue?: string | null;
  varianceValue?: string | null;
}

export interface FoodCostReport {
  site: { id: string; name: string; nameAr: string | null; timezone: string };
  period: { from: string; to: string; stockFrom: string; stockTo: string };
  counts: { start: { id: string; ref: string } | null; end: { id: string; ref: string } | null };
  pos: { connected: boolean; linkedLocations: number; unlinkedLocations: number };
  totals: {
    netSales: string;
    netSalesWithRecipe: string;
    actualCost: string;
    theoreticalCost: string;
    wasteCost: string;
    varianceCost: string;
    actualPct: string | null;
    theoreticalPct: string | null;
    gapPct: string | null;
  } | null;
  rows: FoodCostRow[];
  withoutRecipe: { productId: string; name: string; qty: string; net?: string }[];
  noCost: string[];
  recipesLinked: number;
}

export interface CountPeriod {
  id: string;
  ref: string;
  scope: string;
  postedAt: string;
  date: string;
}
