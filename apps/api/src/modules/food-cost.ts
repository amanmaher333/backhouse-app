import { BadRequestException, Controller, ForbiddenException, Get, Injectable, Module, NotFoundException, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from 'drizzle-orm';
import { type Tx, items, posConnections, posLocations, posProducts, posSalesDaily, recipes, sites, stockCounts, stockMovements } from '@boh/db';
import { Decimal, foodCostReport, recipeUsage, zonedTimeToUtc, type LedgerTotals, type SoldProduct } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { RecipesModule, RecipesService } from './recipes.js';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const ReportSchema = z
  .object({
    siteId: z.string().uuid(),
    from: date.optional(),
    to: date.optional(),
    /** Between two posted counts: exact count times for stock, business days after the first count up to the second for sales. */
    fromCountId: z.string().uuid().optional(),
    toCountId: z.string().uuid().optional(),
  })
  .refine((q) => (q.from && q.to) || (q.fromCountId && q.toCountId), { message: 'Give from and to dates, or two counts' });
class ReportDto extends createZodDto(ReportSchema) {}
class PeriodsDto extends createZodDto(z.object({ siteId: z.string().uuid() })) {}

const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
/** The calendar date of an instant in a time zone. */
const localDate = (t: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

/**
 * Theoretical vs actual food cost for a site and period. Actual comes from the stock ledger
 * (so the period should start and end on a count); theoretical from POS sales × recipes plus
 * recorded waste. See docs/food-cost.md.
 */
@Injectable()
export class FoodCostService {
  constructor(
    private readonly db: DbService,
    private readonly recipesSvc: RecipesService,
  ) {}

  private must(a: AccessContext, siteId: string) {
    if (!a.can('stock:read', siteId)) throw new ForbiddenException('Missing permission stock:read for this site');
    if (!a.can('recipe:read')) throw new ForbiddenException('Missing permission recipe:read');
  }

  /** Posted counts at the site, newest first, to offer "between counts" periods. */
  periods(a: AccessContext, siteId: string) {
    this.must(a, siteId);
    return this.db.tenant(a.tenant, async (tx) => {
      const [site] = await tx.select({ timezone: sites.timezone }).from(sites).where(eq(sites.id, siteId));
      if (!site) throw new NotFoundException('site not found');
      const rows = await tx
        .select({ id: stockCounts.id, ref: stockCounts.ref, scope: stockCounts.scope, postedAt: stockCounts.postedAt })
        .from(stockCounts)
        .where(and(eq(stockCounts.siteId, siteId), eq(stockCounts.status, 'posted'), isNotNull(stockCounts.postedAt)))
        .orderBy(desc(stockCounts.postedAt))
        .limit(24);
      return rows.map((r) => ({ ...r, date: localDate(r.postedAt!, site.timezone) }));
    });
  }

  report(a: AccessContext, q: ReportDto) {
    this.must(a, q.siteId);
    return this.db.tenant(a.tenant, (tx) => this.reportInTx(tx, a, q));
  }

  /** The report inside the caller's transaction (agents use this). */
  async reportInTx(tx: Tx, a: AccessContext, q: z.infer<typeof ReportSchema>) {
    this.must(a, q.siteId);
    {
      const [site] = await tx.select().from(sites).where(eq(sites.id, q.siteId));
      if (!site) throw new NotFoundException('site not found');
      const tz = site.timezone;

      // Period: stock between two instants, sales between two business dates.
      let t0: Date, t1: Date, fromDate: string, toDate: string;
      let counts: { start: { id: string; ref: string } | null; end: { id: string; ref: string } | null };
      if (q.fromCountId && q.toCountId) {
        const cs = await tx.select().from(stockCounts).where(and(inArray(stockCounts.id, [q.fromCountId, q.toCountId]), eq(stockCounts.siteId, q.siteId), eq(stockCounts.status, 'posted')));
        const a0 = cs.find((c) => c.id === q.fromCountId);
        const b0 = cs.find((c) => c.id === q.toCountId);
        if (!a0 || !b0) throw new BadRequestException('Both counts must be posted counts at this site');
        if (a0.postedAt! >= b0.postedAt!) throw new BadRequestException('The first count must come before the second');
        // A count's own adjustments are stamped at (or just before) its posting time: include them on its side.
        t0 = new Date(a0.postedAt!.getTime() + 1);
        t1 = new Date(b0.postedAt!.getTime() + 1);
        // Counts are taken at close of business: sales run from the day after the first count to the day of the second.
        fromDate = addDays(localDate(t0, tz), 1);
        toDate = localDate(t1, tz);
        counts = { start: { id: a0.id, ref: a0.ref }, end: { id: b0.id, ref: b0.ref } };
      } else {
        fromDate = q.from!;
        toDate = q.to!;
        if (fromDate > toDate) throw new BadRequestException('from must be on or before to');
        t0 = zonedTimeToUtc(fromDate, '00:00', tz);
        t1 = zonedTimeToUtc(addDays(toDate, 1), '00:00', tz);
        // A count taken around closing the night before the period, and one around closing on its
        // last day, make the stock figures trustworthy: within 36 hours before or 6 hours into each end.
        const near = async (t: Date, before: number, after: number) => {
          const [c] = await tx
            .select({ id: stockCounts.id, ref: stockCounts.ref })
            .from(stockCounts)
            .where(and(eq(stockCounts.siteId, q.siteId), eq(stockCounts.status, 'posted'), gte(stockCounts.postedAt, new Date(t.getTime() - before * 3600_000)), lte(stockCounts.postedAt, new Date(t.getTime() + after * 3600_000))))
            .orderBy(desc(stockCounts.postedAt))
            .limit(1);
          return c ?? null;
        };
        counts = { start: await near(t0, 36, 6), end: await near(t1, 6, 36) };
      }

      // Ledger totals per item.
      const m = stockMovements;
      const inPeriod = sql`${m.occurredAt} >= ${t0.toISOString()}::timestamptz and ${m.occurredAt} < ${t1.toISOString()}::timestamptz`;
      const ledgerRows = await tx
        .select({
          itemId: m.itemId,
          opening: sql<string>`coalesce(sum(${m.qtyBase}) filter (where ${m.occurredAt} < ${t0.toISOString()}::timestamptz), 0)::text`,
          closing: sql<string>`coalesce(sum(${m.qtyBase}) filter (where ${m.occurredAt} < ${t1.toISOString()}::timestamptz), 0)::text`,
          received: sql<string>`coalesce(sum(${m.qtyBase}) filter (where ${m.type} = 'receipt' and ${inPeriod}), 0)::text`,
          transferIn: sql<string>`coalesce(sum(${m.qtyBase}) filter (where ${m.type} = 'transfer_in' and ${inPeriod}), 0)::text`,
          transferOut: sql<string>`coalesce(-sum(${m.qtyBase}) filter (where ${m.type} = 'transfer_out' and ${inPeriod}), 0)::text`,
          waste: sql<string>`coalesce(-sum(${m.qtyBase}) filter (where ${m.type} = 'waste' and ${inPeriod}), 0)::text`,
        })
        .from(m)
        .where(and(eq(m.siteId, q.siteId), sql`${m.occurredAt} < ${t1.toISOString()}::timestamptz`))
        .groupBy(m.itemId);
      const ledger: LedgerTotals[] = ledgerRows;

      // POS sales at the site's linked locations.
      const [conn] = await tx.select().from(posConnections).where(ne(posConnections.status, 'disconnected')).limit(1);
      const locs = conn ? await tx.select().from(posLocations).where(and(eq(posLocations.connectionId, conn.id), eq(posLocations.siteId, q.siteId))) : [];
      const salesRows = locs.length
        ? await tx
            .select({ productId: posSalesDaily.productExternalId, qty: sql<string>`sum(${posSalesDaily.qty})::text`, net: sql<string>`sum(${posSalesDaily.net})::text` })
            .from(posSalesDaily)
            .where(and(eq(posSalesDaily.connectionId, conn!.id), inArray(posSalesDaily.locationExternalId, locs.map((l) => l.externalId)), gte(posSalesDaily.businessDate, fromDate), lte(posSalesDaily.businessDate, toDate)))
            .groupBy(posSalesDaily.productExternalId)
        : [];
      const products = salesRows.length ? await tx.select().from(posProducts).where(and(eq(posProducts.connectionId, conn!.id), inArray(posProducts.externalId, salesRows.map((s) => s.productId)))) : [];

      // Recipes: which product sells which recipe, and what each uses.
      const { recipes: rs, defs, catalogue } = await this.recipesSvc.definitions(tx, 'average');
      const usage = recipeUsage(defs, catalogue);
      const recipeFor = new Map(rs.filter((r) => r.posProductId).map((r) => [r.posProductId!, r.id]));
      const sales: SoldProduct[] = salesRows.map((s) => {
        const p = products.find((x) => x.externalId === s.productId);
        return { productId: p?.id ?? s.productId, name: p?.name ?? s.productId, qty: s.qty, net: s.net, recipeId: p ? (recipeFor.get(p.id) ?? null) : null };
      });

      // Item names and costs (stock average across sites, else supplier price).
      const itemIds = [...new Set([...ledger.map((l) => l.itemId), ...[...usage.values()].flatMap((u) => [...u.keys()])])];
      const itemRows = itemIds.length ? await tx.select({ id: items.id, name: items.name, nameAr: items.nameAr, baseUnit: items.baseUnit }).from(items).where(inArray(items.id, itemIds)) : [];
      const costs = await this.recipesSvc.itemCosts(tx, itemIds, 'average');
      const r = foodCostReport({ items: new Map(itemRows.map((i) => [i.id, { name: i.name, baseUnit: i.baseUnit, unitCost: costs.get(i.id) ?? null }])), ledger, sales, usage });

      const showCost = a.can('price:read');
      const nameAr = new Map(itemRows.map((i) => [i.id, i.nameAr]));
      const unlinkedLocations = conn ? (await tx.select({ id: posLocations.id }).from(posLocations).where(and(eq(posLocations.connectionId, conn.id), sql`${posLocations.siteId} is null`, sql`${posLocations.deletedAt} is null`))).length : 0;
      return {
        site: { id: site.id, name: site.name, nameAr: site.nameAr, timezone: tz },
        period: { from: fromDate, to: toDate, stockFrom: t0.toISOString(), stockTo: t1.toISOString() },
        counts,
        pos: { connected: Boolean(conn), linkedLocations: locs.length, unlinkedLocations },
        totals: showCost
          ? { netSales: r.netSales, netSalesWithRecipe: r.netSalesWithRecipe, actualCost: r.actualCost, theoreticalCost: r.theoreticalCost, wasteCost: r.wasteCost, varianceCost: r.varianceCost, actualPct: r.actualPct, theoreticalPct: r.theoreticalPct, gapPct: r.actualPct && r.theoreticalPct ? new Decimal(r.actualPct).minus(r.theoreticalPct).toFixed(1) : null }
          : null,
        rows: r.rows.map((row) => ({
          ...row,
          nameAr: nameAr.get(row.itemId) ?? null,
          unitCost: showCost ? row.unitCost : undefined,
          actualValue: showCost ? row.actualValue : undefined,
          theoreticalValue: showCost ? row.theoreticalValue : undefined,
          varianceValue: showCost ? row.varianceValue : undefined,
        })),
        withoutRecipe: r.withoutRecipe.map((w) => ({ ...w, net: showCost ? w.net : undefined })),
        noCost: r.noCost,
        recipesLinked: rs.filter((x) => x.posProductId).length,
      };
    }
  }
}

@ApiTags('recipes')
@ApiBearerAuth()
@Controller('food-cost')
export class FoodCostController {
  constructor(private readonly svc: FoodCostService) {}

  @Get() @Requires('recipe:read')
  report(@Access() a: AccessContext, @Query() q: ReportDto) { return this.svc.report(a, q); }

  @Get('periods') @Requires('recipe:read')
  periods(@Access() a: AccessContext, @Query() q: PeriodsDto) { return this.svc.periods(a, q.siteId); }
}

@Module({ imports: [RecipesModule], controllers: [FoodCostController], providers: [FoodCostService], exports: [FoodCostService] })
export class FoodCostModule {}
export { ReportSchema as FoodCostQuerySchema };
