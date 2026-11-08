import { BadRequestException, Body, Controller, Get, Injectable, Module, NotFoundException, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { itemSiteSettings, items, packs, sites, stockBalances, stockMovements, supplierItems, type Tx } from '@boh/db';
import { Decimal, UNITS, applyMovement, toBase, type PackDef } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { emitEvent } from '../agents/events.js';

const uuid = new ParseUUIDPipe({ version: '4' });

export type MovementType = (typeof stockMovements.$inferInsert)['type'];

export interface MovementInput {
  siteId: string;
  itemId: string;
  type: MovementType;
  qtyBase: Decimal.Value;
  /** Cost per base unit, for incoming stock. */
  unitCost?: Decimal.Value | null;
  sourceType?: string;
  sourceId?: string;
  note?: string | null;
}

const SetOnHandSchema = z.object({
  itemId: z.string().uuid(),
  qty: z.coerce.number().min(0).max(1e9),
  unit: z.string().refine((u) => u in UNITS, 'Unknown unit').optional(),
  packId: z.string().uuid().optional(),
  note: z.string().max(500).nullish(),
});
class SetOnHandDto extends createZodDto(SetOnHandSchema) {}

const MovementsQuery = z.object({ itemId: z.string().uuid().optional(), limit: z.coerce.number().int().min(1).max(500).default(100) });
class MovementsQueryDto extends createZodDto(MovementsQuery) {}

/**
 * Stock ledger. Every change is an append-only movement; the balance row
 * (quantity and weighted average cost) is updated in the same transaction.
 */
@Injectable()
export class StockService {
  constructor(private readonly db: DbService) {}

  /** Post one movement inside the caller's transaction. */
  async post(tx: Tx, a: AccessContext, m: MovementInput) {
    const qty = new Decimal(m.qtyBase);
    if (qty.isZero()) return null;
    const [bal] = await tx
      .select()
      .from(stockBalances)
      .where(and(eq(stockBalances.siteId, m.siteId), eq(stockBalances.itemId, m.itemId)))
      .for('update');
    const next = applyMovement({ qty: bal?.qtyOnHand ?? 0, avgCost: bal?.avgCost ?? 0 }, { qty, unitCost: m.unitCost });
    const unitCost = m.unitCost !== undefined && m.unitCost !== null ? new Decimal(m.unitCost) : new Decimal(bal?.avgCost ?? 0);
    await tx.insert(stockMovements).values({
      orgId: a.orgId,
      siteId: m.siteId,
      itemId: m.itemId,
      type: m.type,
      qtyBase: qty.toFixed(6),
      unitCost: unitCost.toFixed(8),
      totalCost: qty.mul(unitCost).toFixed(4),
      sourceType: m.sourceType ?? null,
      sourceId: m.sourceId ?? null,
      note: m.note ?? null,
      actorType: a.actorType,
      createdBy: a.userId,
    });
    const values = { qtyOnHand: next.qty.toFixed(6), avgCost: next.avgCost.toFixed(8), lastMovementAt: new Date() };
    if (bal) await tx.update(stockBalances).set(values).where(and(eq(stockBalances.siteId, m.siteId), eq(stockBalances.itemId, m.itemId)));
    else await tx.insert(stockBalances).values({ orgId: a.orgId, siteId: m.siteId, itemId: m.itemId, ...values });
    await emitEvent(tx, a, 'stock.changed', { type: 'item', id: m.itemId }, { siteId: m.siteId, itemId: m.itemId, type: m.type, qtyBase: qty.toFixed(6), qtyOnHand: values.qtyOnHand });
    return values;
  }

  /** Stock at one site: every stocked item with on-hand, par and reorder point. */
  async siteStock(a: AccessContext, siteId: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [site] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
      if (!site) throw new NotFoundException('site not found');
      const rows = await tx
        .select({
          itemId: items.id,
          code: items.code,
          name: items.name,
          nameAr: items.nameAr,
          category: items.category,
          baseUnit: items.baseUnit,
          qtyOnHand: stockBalances.qtyOnHand,
          avgCost: stockBalances.avgCost,
          lastMovementAt: stockBalances.lastMovementAt,
          parLevel: itemSiteSettings.parLevel,
          reorderPoint: itemSiteSettings.reorderPoint,
        })
        .from(items)
        .leftJoin(stockBalances, and(eq(stockBalances.itemId, items.id), eq(stockBalances.siteId, siteId)))
        .leftJoin(itemSiteSettings, and(eq(itemSiteSettings.itemId, items.id), eq(itemSiteSettings.siteId, siteId)))
        .where(and(eq(items.isActive, true), eq(items.isStockable, true)))
        .orderBy(asc(items.name));
      const showCost = a.can('price:read');
      return rows.map((r) => {
        const onHand = new Decimal(r.qtyOnHand ?? 0);
        const reorderAt = r.reorderPoint ?? r.parLevel;
        const status = r.parLevel === null ? 'no_par' : reorderAt !== null && onHand.lte(reorderAt) ? 'low' : 'ok';
        return {
          ...r,
          qtyOnHand: onHand.toFixed(6),
          avgCost: showCost ? r.avgCost : undefined,
          value: showCost && r.avgCost ? onHand.mul(r.avgCost).toFixed(2) : undefined,
          status,
        };
      });
    });
  }

  /** Set the counted quantity for an item (an adjustment movement for the difference). */
  async setOnHand(a: AccessContext, siteId: string, dto: SetOnHandDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [item] = await tx.select().from(items).where(eq(items.id, dto.itemId));
      if (!item) throw new NotFoundException('item not found');
      const itemPacks = await tx.select().from(packs).where(eq(packs.itemId, item.id));
      if (dto.packId && !itemPacks.some((p) => p.id === dto.packId)) throw new BadRequestException('packId is not a pack of this item');
      const defs: PackDef[] = itemPacks.map((p) => ({ id: p.id, name: p.name, qty: p.qty, unit: p.unit ?? undefined, packId: p.parentPackId ?? undefined }));
      const target = toBase(dto.qty, dto.packId ? { packId: dto.packId } : { unit: dto.unit ?? item.baseUnit }, { baseUnit: item.baseUnit, packs: defs, conversions: item.conversions });
      const [bal] = await tx.select().from(stockBalances).where(and(eq(stockBalances.siteId, siteId), eq(stockBalances.itemId, item.id)));
      const diff = target.minus(bal?.qtyOnHand ?? 0);
      // First count of an item with no cost history: use its cheapest supplier cost, so stock value is meaningful.
      let unitCost: Decimal | null = null;
      if (diff.gt(0) && (!bal || new Decimal(bal.avgCost).isZero())) {
        const [best] = await tx
          .select({ cost: sql<string>`min(${supplierItems.currentPrice} / nullif(${packs.baseQty}, 0))::text` })
          .from(supplierItems)
          .innerJoin(packs, eq(packs.id, supplierItems.packId))
          .where(and(eq(supplierItems.itemId, item.id), eq(supplierItems.isActive, true)));
        if (best?.cost) unitCost = new Decimal(best.cost);
      }
      const result = await this.post(tx, a, {
        siteId,
        itemId: item.id,
        type: bal ? 'adjustment' : 'opening',
        qtyBase: diff,
        unitCost,
        sourceType: 'count',
        note: dto.note ?? null,
      });
      await audit(tx, a, { action: 'stock.set_on_hand', entityType: 'item', entityId: item.id, before: { siteId, qtyOnHand: bal?.qtyOnHand ?? '0' }, after: { siteId, qtyOnHand: target.toFixed(6) } });
      return { itemId: item.id, siteId, qtyOnHand: result?.qtyOnHand ?? target.toFixed(6), changedBy: diff.toFixed(6) };
    });
  }

  movements(a: AccessContext, siteId: string, q: MovementsQueryDto) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select()
        .from(stockMovements)
        .where(and(eq(stockMovements.siteId, siteId), q.itemId ? eq(stockMovements.itemId, q.itemId) : undefined))
        .orderBy(desc(stockMovements.id))
        .limit(q.limit),
    );
  }

  /** On-hand per item for a set of sites (used by the Purchasing agent). */
  async balances(tx: Tx, siteIds: string[]) {
    if (!siteIds.length) return [];
    return tx.select().from(stockBalances).where(inArray(stockBalances.siteId, siteIds));
  }
}

@ApiTags('stock')
@ApiBearerAuth()
@Controller('sites/:siteId/stock')
export class StockController {
  constructor(private readonly svc: StockService) {}

  @Get() @Requires('stock:read', { siteParam: 'siteId' })
  list(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string) { return this.svc.siteStock(a, siteId); }

  @Post('set') @Requires('stock:manage', { siteParam: 'siteId' })
  set(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Body() dto: SetOnHandDto) { return this.svc.setOnHand(a, siteId, dto); }

  @Get('movements') @Requires('stock:read', { siteParam: 'siteId' })
  movements(@Access() a: AccessContext, @Param('siteId', uuid) siteId: string, @Query() q: MovementsQueryDto) { return this.svc.movements(a, siteId, q); }
}

@Module({ controllers: [StockController], providers: [StockService], exports: [StockService] })
export class StockModule {}


