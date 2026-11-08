import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Header,
  HttpCode,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { and, asc, desc, eq, gte, isNotNull, ne, sql } from 'drizzle-orm';
import {
  items,
  packs,
  supplierItemPrices,
  supplierItems,
  supplierProfiles,
  supplierSiteSettings,
  tradingRelationships,
  type Tx,
} from '@boh/db';
import { Decimal, ORDER_CHANNELS, isValidKsaCrNumber, isValidKsaVatNumber, normalizeName, parseCsvObjects, pctChange, writeCsv } from '@boh/domain';
import { DbService } from '../common/db.service.js';
import { Access, Requires } from '../common/auth.js';
import type { AccessContext } from '../common/access.js';
import { audit } from '../common/audit.js';
import { emitEvent } from '../agents/events.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const money = z.coerce
  .number()
  .min(0)
  .max(10_000_000)
  .transform((n) => new Decimal(n).toDecimalPlaces(4).toString());
const phone = z.string().regex(/^\+[1-9]\d{6,14}$/, 'Phone must be E.164, e.g. +9665XXXXXXXX');

const RelationshipFields = {
  displayName: z.string().trim().min(1).max(200),
  displayNameAr: z.string().trim().max(200).nullish(),
  orderChannel: z.enum(ORDER_CHANNELS),
  contactName: z.string().max(200).nullish(),
  contactEmail: z.string().email().max(254).nullish(),
  contactPhone: phone.nullish(),
  accountNumber: z.string().max(60).nullish(),
  paymentTermsDays: z.coerce.number().int().min(0).max(365),
  minOrderValue: money.nullish(),
  deliveryFee: money.nullish(),
  taxRate: z.coerce.number().min(0).max(1).transform(String),
  hidePricesOnPo: z.boolean(),
  invoiceSenderWhitelist: z.array(z.string().email()).max(20),
  notes: z.string().max(2000).nullish(),
};

const CreateSupplierSchema = z
  .object({
    ...RelationshipFields,
    orderChannel: RelationshipFields.orderChannel.default('email'),
    paymentTermsDays: RelationshipFields.paymentTermsDays.default(30),
    taxRate: RelationshipFields.taxRate.default(0.15),
    hidePricesOnPo: RelationshipFields.hidePricesOnPo.default(false),
    invoiceSenderWhitelist: RelationshipFields.invoiceSenderWhitelist.default([]),
    vatNumber: z.string().trim().nullish(),
    crNumber: z.string().trim().nullish(),
  })
  .superRefine((v, ctx) => {
    if (v.vatNumber && !isValidKsaVatNumber(v.vatNumber))
      ctx.addIssue({ code: 'custom', path: ['vatNumber'], message: 'KSA VAT number must be 15 digits starting and ending with 3' });
    if (v.crNumber && !isValidKsaCrNumber(v.crNumber)) ctx.addIssue({ code: 'custom', path: ['crNumber'], message: 'KSA CR number must be 10 digits' });
    if (v.orderChannel === 'email' && !v.contactEmail) ctx.addIssue({ code: 'custom', path: ['contactEmail'], message: 'Email ordering needs a contact email' });
    if (v.orderChannel === 'whatsapp' && !v.contactPhone) ctx.addIssue({ code: 'custom', path: ['contactPhone'], message: 'WhatsApp ordering needs a mobile number' });
  });
class CreateSupplierDto extends createZodDto(CreateSupplierSchema) {}
const UpdateSupplierSchema = z.object({ ...RelationshipFields, isActive: z.boolean() }).partial();
class UpdateSupplierDto extends createZodDto(UpdateSupplierSchema) {}

const ScheduleSchema = z.object({
  deliveryDays: z.array(z.number().int().min(0).max(6)).max(7),
  cutoffTime: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM (24h)')
    .nullish(),
  leadTimeDays: z.coerce.number().int().min(0).max(60).default(1),
  accountNumber: z.string().max(60).nullish(),
});
class ScheduleDto extends createZodDto(ScheduleSchema) {}

const CreateSupplierItemSchema = z.object({
  itemId: z.string().uuid(),
  packId: z.string().uuid(),
  supplierSku: z.string().trim().max(60).nullish(),
  supplierName: z.string().trim().max(300).nullish(),
  price: money,
  isPreferred: z.boolean().default(false),
});
class CreateSupplierItemDto extends createZodDto(CreateSupplierItemSchema) {}
const UpdateSupplierItemSchema = z
  .object({
    supplierSku: z.string().trim().max(60).nullish(),
    supplierName: z.string().trim().max(300).nullish(),
    isPreferred: z.boolean(),
    isActive: z.boolean(),
  })
  .partial();
class UpdateSupplierItemDto extends createZodDto(UpdateSupplierItemSchema) {}

const PriceSchema = z.object({
  price: money,
  siteId: z.string().uuid().nullish(),
  effectiveFrom: z.coerce.date().optional(),
});
class PriceDto extends createZodDto(PriceSchema) {}

const ChangesSchema = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  itemId: z.string().uuid().optional(),
});
class ChangesDto extends createZodDto(ChangesSchema) {}

const ImportSchema = z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(true) });
class ImportDto extends createZodDto(ImportSchema) {}

@Injectable()
export class SuppliersService {
  constructor(private readonly db: DbService) {}

  private async loadRel(tx: Tx, id: string) {
    const [rel] = await tx.select().from(tradingRelationships).where(eq(tradingRelationships.id, id));
    if (!rel) throw new NotFoundException('supplier not found');
    return rel;
  }

  list(a: AccessContext, includeInactive = false) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({
          id: tradingRelationships.id,
          displayName: tradingRelationships.displayName,
          displayNameAr: tradingRelationships.displayNameAr,
          orderChannel: tradingRelationships.orderChannel,
          contactName: tradingRelationships.contactName,
          contactEmail: tradingRelationships.contactEmail,
          contactPhone: tradingRelationships.contactPhone,
          paymentTermsDays: tradingRelationships.paymentTermsDays,
          isActive: tradingRelationships.isActive,
          vatNumber: supplierProfiles.vatNumber,
          isClaimed: sql<boolean>`${supplierProfiles.claimedOrgId} is not null`,
          itemCount: sql<number>`(select count(*)::int from ${supplierItems} where ${supplierItems.relationshipId} = ${tradingRelationships.id} and ${supplierItems.isActive})`,
          lastPriceChange: sql<string | null>`(select max(${supplierItems.priceUpdatedAt}) from ${supplierItems} where ${supplierItems.relationshipId} = ${tradingRelationships.id})`,
        })
        .from(tradingRelationships)
        .innerJoin(supplierProfiles, eq(supplierProfiles.id, tradingRelationships.supplierProfileId))
        .where(includeInactive ? eq(tradingRelationships.orgId, a.orgId) : and(eq(tradingRelationships.orgId, a.orgId), eq(tradingRelationships.isActive, true)))
        .orderBy(asc(tradingRelationships.displayName)),
    );
  }

  /**
   * Find the shared supplier profile by VAT number (or create an unclaimed one),
   * then create this org's trading relationship with it.
   */
  async create(a: AccessContext, dto: CreateSupplierDto) {
    const { vatNumber, crNumber, ...rel } = dto;
    // Owner connection: profiles are shared across tenants and written only here.
    const profileId = await this.db.system(async (tx) => {
      if (vatNumber) {
        const [found] = await tx
          .select({ id: supplierProfiles.id })
          .from(supplierProfiles)
          .where(and(eq(supplierProfiles.country, 'SA'), eq(supplierProfiles.vatNumber, vatNumber)));
        if (found) return found.id;
      }
      const [p] = await tx
        .insert(supplierProfiles)
        .values({ name: dto.displayName, nameAr: dto.displayNameAr ?? null, vatNumber: vatNumber ?? null, crNumber: crNumber ?? null, createdByOrgId: a.orgId })
        .onConflictDoNothing()
        .returning({ id: supplierProfiles.id });
      if (p) return p.id;
      // Lost a race with another org creating the same VAT number.
      const [again] = await tx.select({ id: supplierProfiles.id }).from(supplierProfiles).where(eq(supplierProfiles.vatNumber, vatNumber!));
      return again!.id;
    });

    return this.db.tenant(a.tenant, async (tx) => {
      const existing = await tx
        .select({ id: tradingRelationships.id })
        .from(tradingRelationships)
        .where(and(eq(tradingRelationships.orgId, a.orgId), eq(tradingRelationships.supplierProfileId, profileId)));
      if (existing.length) throw new ConflictException({ statusCode: 409, message: 'You already have this supplier', supplierId: existing[0]!.id });
      const [row] = await tx
        .insert(tradingRelationships)
        .values({ ...rel, orgId: a.orgId, supplierProfileId: profileId })
        .returning();
      await audit(tx, a, { action: 'supplier.created', entityType: 'supplier', entityId: row!.id, after: row });
      return row;
    });
  }

  get(a: AccessContext, id: string) {
    const showPrices = a.can('price:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const rel = await this.loadRel(tx, id);
      const [profile] = await tx.select().from(supplierProfiles).where(eq(supplierProfiles.id, rel.supplierProfileId));
      const schedule = await tx.select().from(supplierSiteSettings).where(eq(supplierSiteSettings.relationshipId, id));
      const lines = await this.itemsFor(tx, id, showPrices);
      return {
        ...rel,
        profile: profile ? { vatNumber: profile.vatNumber, crNumber: profile.crNumber, isClaimed: profile.claimedOrgId !== null } : null,
        schedule,
        items: lines,
      };
    });
  }

  private async itemsFor(tx: Tx, relationshipId: string, showPrices: boolean) {
    const rows = await tx
      .select({
        id: supplierItems.id,
        itemId: supplierItems.itemId,
        itemCode: items.code,
        itemName: items.name,
        itemNameAr: items.nameAr,
        baseUnit: items.baseUnit,
        packId: supplierItems.packId,
        packName: packs.name,
        packNameAr: packs.nameAr,
        packBaseQty: packs.baseQty,
        supplierSku: supplierItems.supplierSku,
        supplierName: supplierItems.supplierName,
        currentPrice: supplierItems.currentPrice,
        currency: supplierItems.currency,
        priceUpdatedAt: supplierItems.priceUpdatedAt,
        isPreferred: supplierItems.isPreferred,
        isActive: supplierItems.isActive,
        previousPrice: sql<string | null>`(select ${supplierItemPrices.previousPrice}::text from ${supplierItemPrices}
            where ${supplierItemPrices.supplierItemId} = ${supplierItems.id} and ${supplierItemPrices.siteId} is null
            order by ${supplierItemPrices.id} desc limit 1)`,
      })
      .from(supplierItems)
      .innerJoin(items, eq(items.id, supplierItems.itemId))
      .innerJoin(packs, eq(packs.id, supplierItems.packId))
      .where(eq(supplierItems.relationshipId, relationshipId))
      .orderBy(asc(items.name));
    return rows.map((r) => {
      if (!showPrices) return { ...r, currentPrice: undefined, previousPrice: undefined, costPerBase: undefined, changePct: undefined };
      return {
        ...r,
        costPerBase: new Decimal(r.currentPrice).div(r.packBaseQty).toString(),
        changePct: pctChange(r.previousPrice, r.currentPrice),
      };
    });
  }

  update(a: AccessContext, id: string, dto: UpdateSupplierDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const before = await this.loadRel(tx, id);
      if (Object.keys(dto).length === 0) return before;
      const [after] = await tx.update(tradingRelationships).set(dto).where(eq(tradingRelationships.id, id)).returning();
      await audit(tx, a, { action: 'supplier.updated', entityType: 'supplier', entityId: id, before, after });
      return after;
    });
  }

  setSchedule(a: AccessContext, id: string, siteId: string, dto: ScheduleDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.loadRel(tx, id);
      const values = { ...dto, deliveryDays: [...new Set(dto.deliveryDays)].sort() };
      const [before] = await tx.select().from(supplierSiteSettings).where(and(eq(supplierSiteSettings.relationshipId, id), eq(supplierSiteSettings.siteId, siteId)));
      const [after] = await tx
        .insert(supplierSiteSettings)
        .values({ orgId: a.orgId, relationshipId: id, siteId, ...values })
        .onConflictDoUpdate({ target: [supplierSiteSettings.relationshipId, supplierSiteSettings.siteId], set: values })
        .returning();
      await audit(tx, a, { action: 'supplier.schedule_updated', entityType: 'supplier', entityId: id, before: before ?? null, after });
      return after;
    });
  }

  // ---------- Supplier items & prices ----------
  private async writePrice(
    tx: Tx,
    a: AccessContext,
    si: typeof supplierItems.$inferSelect,
    price: string,
    source: 'manual' | 'import' | 'invoice' | 'supplier',
    siteId: string | null = null,
    effectiveFrom?: Date,
  ) {
    const previous = siteId
      ? ((
          await tx
            .select({ price: supplierItemPrices.price })
            .from(supplierItemPrices)
            .where(and(eq(supplierItemPrices.supplierItemId, si.id), eq(supplierItemPrices.siteId, siteId)))
            .orderBy(desc(supplierItemPrices.id))
            .limit(1)
        )[0]?.price ?? si.currentPrice)
      : si.currentPrice;
    if (new Decimal(previous).eq(price) && !siteId) return null; // no change
    const [row] = await tx
      .insert(supplierItemPrices)
      .values({
        orgId: a.orgId,
        supplierItemId: si.id,
        siteId,
        price,
        previousPrice: previous,
        currency: si.currency,
        source,
        effectiveFrom: effectiveFrom ?? new Date(),
        recordedBy: a.userId,
      })
      .returning();
    if (!siteId) await tx.update(supplierItems).set({ currentPrice: price, priceUpdatedAt: new Date() }).where(eq(supplierItems.id, si.id));
    // Agents (e.g. Price Watch) react to this event; it commits with the price change or not at all.
    await emitEvent(tx, a, 'price.changed', { type: 'supplier_item', id: si.id }, {
      supplierItemId: si.id,
      itemId: si.itemId,
      relationshipId: si.relationshipId,
      price,
      previousPrice: previous,
      siteId,
      source,
    });
    return row;
  }

  private async setPreferred(tx: Tx, itemId: string, supplierItemId: string) {
    await tx
      .update(supplierItems)
      .set({ isPreferred: false })
      .where(and(eq(supplierItems.itemId, itemId), ne(supplierItems.id, supplierItemId), eq(supplierItems.isPreferred, true)));
  }

  listItems(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, async (tx) => {
      await this.loadRel(tx, id);
      return this.itemsFor(tx, id, a.can('price:read'));
    });
  }

  createItem(a: AccessContext, relationshipId: string, dto: CreateSupplierItemDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const rel = await this.loadRel(tx, relationshipId);
      const [pack] = await tx.select().from(packs).where(and(eq(packs.id, dto.packId), eq(packs.itemId, dto.itemId)));
      if (!pack) throw new BadRequestException('packId is not a pack of itemId');
      const [si] = await tx
        .insert(supplierItems)
        .values({
          orgId: a.orgId,
          relationshipId,
          itemId: dto.itemId,
          packId: dto.packId,
          supplierSku: dto.supplierSku || null,
          supplierName: dto.supplierName || null,
          supplierNameNorm: dto.supplierName ? normalizeName(dto.supplierName) : null,
          currentPrice: dto.price,
          currency: rel.currency,
          isPreferred: dto.isPreferred,
        })
        .returning();
      if (dto.isPreferred) await this.setPreferred(tx, dto.itemId, si!.id);
      // First price is recorded too, so the history starts at the beginning.
      await tx.insert(supplierItemPrices).values({
        orgId: a.orgId,
        supplierItemId: si!.id,
        price: dto.price,
        previousPrice: null,
        currency: rel.currency,
        source: 'manual',
        recordedBy: a.userId,
      });
      await audit(tx, a, { action: 'supplier_item.created', entityType: 'supplier_item', entityId: si!.id, after: si });
      return si;
    });
  }

  updateItem(a: AccessContext, id: string, dto: UpdateSupplierItemDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select().from(supplierItems).where(eq(supplierItems.id, id));
      if (!before) throw new NotFoundException('supplier item not found');
      const values: Partial<typeof supplierItems.$inferInsert> = { ...dto };
      if (dto.supplierName !== undefined) values.supplierNameNorm = dto.supplierName ? normalizeName(dto.supplierName) : null;
      const [after] = await tx.update(supplierItems).set(values).where(eq(supplierItems.id, id)).returning();
      if (dto.isPreferred) await this.setPreferred(tx, before.itemId, id);
      await audit(tx, a, { action: 'supplier_item.updated', entityType: 'supplier_item', entityId: id, before, after });
      return after;
    });
  }

  setPrice(a: AccessContext, id: string, dto: PriceDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [si] = await tx.select().from(supplierItems).where(eq(supplierItems.id, id));
      if (!si) throw new NotFoundException('supplier item not found');
      const row = await this.writePrice(tx, a, si, dto.price, 'manual', dto.siteId ?? null, dto.effectiveFrom);
      return { changed: row !== null, price: row };
    });
  }

  priceHistory(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, (tx) =>
      tx.select().from(supplierItemPrices).where(eq(supplierItemPrices.supplierItemId, id)).orderBy(desc(supplierItemPrices.id)).limit(200),
    );
  }

  /** Recent price changes across all suppliers (feeds the overview and, later, the agent). */
  priceChanges(a: AccessContext, q: ChangesDto) {
    return this.db.tenant(a.tenant, async (tx) => {
      const rows = await tx
        .select({
          id: supplierItemPrices.id,
          supplierItemId: supplierItemPrices.supplierItemId,
          price: supplierItemPrices.price,
          previousPrice: supplierItemPrices.previousPrice,
          source: supplierItemPrices.source,
          siteId: supplierItemPrices.siteId,
          at: supplierItemPrices.effectiveFrom,
          itemId: items.id,
          itemName: items.name,
          itemNameAr: items.nameAr,
          packName: packs.name,
          packNameAr: packs.nameAr,
          supplierId: tradingRelationships.id,
          supplierName: tradingRelationships.displayName,
          supplierNameAr: tradingRelationships.displayNameAr,
        })
        .from(supplierItemPrices)
        .innerJoin(supplierItems, eq(supplierItems.id, supplierItemPrices.supplierItemId))
        .innerJoin(items, eq(items.id, supplierItems.itemId))
        .innerJoin(packs, eq(packs.id, supplierItems.packId))
        .innerJoin(tradingRelationships, eq(tradingRelationships.id, supplierItems.relationshipId))
        .where(
          and(
            isNotNull(supplierItemPrices.previousPrice),
            gte(supplierItemPrices.effectiveFrom, new Date(Date.now() - q.days * 86_400_000)),
            q.itemId ? eq(items.id, q.itemId) : undefined,
          ),
        )
        .orderBy(desc(supplierItemPrices.effectiveFrom), desc(supplierItemPrices.id))
        .limit(q.limit);
      return rows.map((r) => ({ ...r, changePct: pctChange(r.previousPrice, r.price) }));
    });
  }

  // ---------- Price list CSV ----------
  async exportPrices(a: AccessContext, id: string) {
    const rows = await this.db.tenant(a.tenant, async (tx) => {
      await this.loadRel(tx, id);
      return this.itemsFor(tx, id, true);
    });
    return writeCsv(
      ['supplier_sku', 'supplier_name', 'item_code', 'item_name', 'pack', 'price', 'active'],
      rows.map((r) => ({
        supplier_sku: r.supplierSku ?? '',
        supplier_name: r.supplierName ?? '',
        item_code: r.itemCode,
        item_name: r.itemName,
        pack: r.packName,
        price: r.currentPrice,
        active: r.isActive ? 'yes' : 'no',
      })),
    );
  }

  /**
   * Price list import. Columns: supplier_sku, supplier_name, item_code or item_name,
   * pack (pack name; the item's first orderable pack if empty), price.
   * Existing lines are found by SKU, then by item + pack. All or nothing.
   */
  async importPrices(a: AccessContext, id: string, dto: ImportDto) {
    const { headers, rows } = parseCsvObjects(dto.csv);
    if (!headers.includes('price')) throw new BadRequestException('CSV needs a "price" column');
    if (!headers.includes('item_code') && !headers.includes('item_name') && !headers.includes('supplier_sku')) {
      throw new BadRequestException('CSV needs item_code, item_name or supplier_sku');
    }
    type Outcome = { row: number; action: 'create' | 'price' | 'skip' | 'error'; label: string; errors: string[]; oldPrice?: string; newPrice?: string; changePct?: number | null };

    const results = await this.db.tenant(a.tenant, async (tx) => {
      const rel = await this.loadRel(tx, id);
      const orgItems = await tx.select().from(items).where(eq(items.orgId, a.orgId));
      const byCode = new Map(orgItems.map((i) => [i.code.toLowerCase(), i]));
      const byName = new Map(orgItems.flatMap((i) => [[i.name.toLowerCase(), i] as const, ...(i.nameAr ? [[i.nameAr, i] as const] : [])]));
      const orgPacks = await tx.select().from(packs).where(eq(packs.orgId, a.orgId));
      const lines = await tx.select().from(supplierItems).where(eq(supplierItems.relationshipId, id));
      const bySku = new Map(lines.filter((l) => l.supplierSku).map((l) => [l.supplierSku!.toLowerCase(), l]));
      const byPack = new Map(lines.map((l) => [l.packId, l]));
      const out: Outcome[] = [];

      for (const [i, r] of rows.entries()) {
        const rowNo = i + 2;
        const label = r.supplier_name || r.item_name || r.item_code || r.supplier_sku || `row ${rowNo}`;
        const errors: string[] = [];
        const priceNum = Number((r.price ?? '').replace(/,/g, ''));
        if (!r.price || !Number.isFinite(priceNum) || priceNum < 0) errors.push('price must be a number ≥ 0');
        const price = errors.length ? '0' : new Decimal(priceNum).toDecimalPlaces(4).toString();

        let line = r.supplier_sku ? bySku.get(r.supplier_sku.toLowerCase()) : undefined;
        let itemRow = line ? orgItems.find((x) => x.id === line!.itemId) : undefined;
        if (!line) {
          itemRow = (r.item_code && byCode.get(r.item_code.toLowerCase())) || (r.item_name && byName.get(r.item_name.toLowerCase())) || undefined;
          if (!itemRow) errors.push('item not found (use item_code or the exact item name)');
        }
        let packRow: (typeof orgPacks)[number] | undefined;
        if (itemRow && !line) {
          const candidates = orgPacks.filter((p) => p.itemId === itemRow!.id);
          packRow = r.pack
            ? candidates.find((p) => p.name.toLowerCase() === r.pack!.toLowerCase() || p.nameAr === r.pack)
            : candidates.filter((p) => p.isOrderable).sort((x, y) => Number(x.baseQty) - Number(y.baseQty))[0];
          if (!packRow) errors.push(r.pack ? `pack "${r.pack}" not found for this item` : 'item has no orderable pack');
          else line = byPack.get(packRow.id);
        }
        if (errors.length) {
          out.push({ row: rowNo, action: 'error', label, errors });
          continue;
        }

        if (line) {
          const changed = !new Decimal(line.currentPrice).eq(price);
          const meta = { oldPrice: line.currentPrice, newPrice: price, changePct: pctChange(line.currentPrice, price) };
          if (!dto.dryRun) {
            if (changed) await this.writePrice(tx, a, line, price, 'import');
            const nameChange = (r.supplier_name && r.supplier_name !== line.supplierName) || (r.supplier_sku && r.supplier_sku !== line.supplierSku);
            if (nameChange) {
              await tx
                .update(supplierItems)
                .set({
                  supplierName: r.supplier_name || line.supplierName,
                  supplierNameNorm: r.supplier_name ? normalizeName(r.supplier_name) : line.supplierNameNorm,
                  supplierSku: r.supplier_sku || line.supplierSku,
                })
                .where(eq(supplierItems.id, line.id));
            }
          }
          out.push({ row: rowNo, action: changed ? 'price' : 'skip', label, errors: [], ...meta });
          continue;
        }

        if (!dto.dryRun) {
          const [si] = await tx
            .insert(supplierItems)
            .values({
              orgId: a.orgId,
              relationshipId: id,
              itemId: itemRow!.id,
              packId: packRow!.id,
              supplierSku: r.supplier_sku || null,
              supplierName: r.supplier_name || null,
              supplierNameNorm: r.supplier_name ? normalizeName(r.supplier_name) : null,
              currentPrice: price,
              currency: rel.currency,
            })
            .returning();
          await tx.insert(supplierItemPrices).values({ orgId: a.orgId, supplierItemId: si!.id, price, currency: rel.currency, source: 'import', recordedBy: a.userId });
          byPack.set(packRow!.id, si!);
          if (si!.supplierSku) bySku.set(si!.supplierSku.toLowerCase(), si!);
        }
        out.push({ row: rowNo, action: 'create', label, errors: [], newPrice: price });
      }

      if (!dto.dryRun && out.some((o) => o.action === 'error')) {
        throw new BadRequestException({ statusCode: 400, message: 'Fix the rows with errors and try again', results: out });
      }
      if (!dto.dryRun) {
        await audit(tx, a, {
          action: 'supplier.price_list_imported',
          entityType: 'supplier',
          entityId: id,
          after: { rows: out.length, created: out.filter((o) => o.action === 'create').length, priced: out.filter((o) => o.action === 'price').length },
        });
      }
      return out;
    });
    const count = (k: string) => results.filter((r) => r.action === k).length;
    return { dryRun: dto.dryRun, summary: { create: count('create'), price: count('price'), skip: count('skip'), error: count('error') }, results };
  }
}

@ApiTags('suppliers')
@ApiBearerAuth()
@Controller()
export class SuppliersController {
  constructor(private readonly svc: SuppliersService) {}

  @Get('suppliers') @Requires('supplier:read')
  list(@Access() a: AccessContext, @Query('all') all?: string) { return this.svc.list(a, all === 'true'); }

  @Post('suppliers') @Requires('supplier:manage')
  create(@Access() a: AccessContext, @Body() dto: CreateSupplierDto) { return this.svc.create(a, dto); }

  @Get('suppliers/:id') @Requires('supplier:read')
  get(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.get(a, id); }

  @Patch('suppliers/:id') @Requires('supplier:manage')
  update(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateSupplierDto) { return this.svc.update(a, id, dto); }

  @Put('suppliers/:id/sites/:siteId') @Requires('supplier:manage', { siteParam: 'siteId' })
  schedule(@Access() a: AccessContext, @Param('id', uuid) id: string, @Param('siteId', uuid) siteId: string, @Body() dto: ScheduleDto) {
    return this.svc.setSchedule(a, id, siteId, dto);
  }

  @Get('suppliers/:id/items') @Requires('supplier:read')
  listItems(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.listItems(a, id); }

  @Post('suppliers/:id/items') @Requires('price:manage')
  createItem(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: CreateSupplierItemDto) { return this.svc.createItem(a, id, dto); }

  @Get('suppliers/:id/prices/export') @Requires('price:read')
  @Header('content-type', 'text/csv; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="price-list.csv"')
  exportPrices(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.exportPrices(a, id); }

  @Post('suppliers/:id/prices/import') @Requires('price:manage') @HttpCode(200)
  importPrices(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: ImportDto) { return this.svc.importPrices(a, id, dto); }

  @Patch('supplier-items/:id') @Requires('price:manage')
  updateItem(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: UpdateSupplierItemDto) { return this.svc.updateItem(a, id, dto); }

  @Post('supplier-items/:id/prices') @Requires('price:manage')
  setPrice(@Access() a: AccessContext, @Param('id', uuid) id: string, @Body() dto: PriceDto) { return this.svc.setPrice(a, id, dto); }

  @Get('supplier-items/:id/prices') @Requires('price:read')
  history(@Access() a: AccessContext, @Param('id', uuid) id: string) { return this.svc.priceHistory(a, id); }

  @Get('price-changes') @Requires('price:read')
  changes(@Access() a: AccessContext, @Query() q: ChangesDto) { return this.svc.priceChanges(a, q); }
}

@Module({ controllers: [SuppliersController], providers: [SuppliersService] })
export class SuppliersModule {}

