import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes, randomInt } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  goodsReceiptLines,
  goodsReceipts,
  items,
  posConnections,
  posItems,
  posLocations,
  posOauthStates,
  posOrders,
  posProducts,
  posPushes,
  posSalesDaily,
  posWebhookEvents,
  purchaseOrders,
  sites,
  type Tx,
} from '@boh/db';
import { Decimal, bestNameMatch, orderSalesLines, posStorageInBase, toPosStorageQty } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../../config.js';
import { DbService } from '../../common/db.service.js';
import type { AccessContext } from '../../common/access.js';
import { audit } from '../../common/audit.js';
import { Sealer } from '../../common/secrets.js';
import { FOODICS_API, FoodicsError, type FoodicsApi, type FoodicsBranch, type FoodicsOrder } from './client.js';

type Conn = typeof posConnections.$inferSelect;
const PROVIDER = 'foodics';
/** Scopes Backhouse asks Foodics for (see docs/foodics.md). */
export const FOODICS_SCOPES = [
  'general.read',
  'inventory.settings.read',
  'inventory.settings.write',
  'inventory.transactions.read',
  'inventory.transactions.write',
  'users.write',
  'orders.list',
  'menu.ingredients.read',
  'tokens.limited.revoke',
];
const STATE_TTL_MS = 10 * 60_000;
/** Days of sales history imported when a business first connects. */
const HISTORY_DAYS = 35;
/** How often the worker refreshes the catalogue and pulls new orders. */
const CATALOG_EVERY_MS = 12 * 3600_000;
const ORDERS_EVERY_MS = 10 * 60_000;
const MAX_PUSH_ATTEMPTS = 5;

/**
 * Foodics: connect a Foodics account (OAuth), keep its branches, inventory items and menu in
 * sync, map them to our sites and items, import sales, and record our goods receipts as
 * purchases in Foodics inventory.
 */
@Injectable()
export class FoodicsService {
  private readonly logger = new Logger('Foodics');
  private readonly sealer: Sealer;

  constructor(
    private readonly db: DbService,
    @Inject(FOODICS_API) readonly api: FoodicsApi,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {
    this.sealer = new Sealer(config, 'pos');
    if (api.mode !== 'simulated' && (!config.FOODICS_CLIENT_ID || !config.FOODICS_CLIENT_SECRET)) this.logger.warn('FOODICS_CLIENT_ID / FOODICS_CLIENT_SECRET are not set: connecting Foodics will fail');
  }

  get mode() {
    return this.api.mode;
  }

  private must(a: AccessContext, perm: 'pos:read' | 'pos:manage') {
    if (!a.holdsOrgWide(perm)) throw new ForbiddenException(`Missing permission ${perm}`);
  }

  private async live(tx: Tx): Promise<Conn | null> {
    const [c] = await tx.select().from(posConnections).where(and(eq(posConnections.provider, PROVIDER), ne(posConnections.status, 'disconnected'))).orderBy(desc(posConnections.connectedAt)).limit(1);
    return c ?? null;
  }
  private async mustLive(tx: Tx) {
    const c = await this.live(tx);
    if (!c) throw new NotFoundException('Foodics is not connected');
    return c;
  }
  private token(c: Conn) {
    if (!c.tokenSealed) throw new BadRequestException('Foodics needs to be connected again');
    return this.sealer.open(c.tokenSealed);
  }

  /** A Foodics call that marks the connection if Foodics rejects the token. */
  private async call<T>(c: Conn, fn: (token: string) => Promise<T>): Promise<T> {
    try {
      return await fn(this.token(c));
    } catch (e) {
      if (e instanceof FoodicsError && e.status === 401) {
        await this.db.system((tx) => tx.update(posConnections).set({ status: 'error', lastError: 'Foodics rejected the access token; connect again', updatedAt: new Date() }).where(eq(posConnections.id, c.id)));
      }
      throw e;
    }
  }

  // ---------- connecting ----------

  async status(a: AccessContext) {
    this.must(a, 'pos:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.live(tx);
      const base = { provider: PROVIDER, mode: this.mode, scopes: FOODICS_SCOPES };
      if (!c) return { ...base, connected: false as const };
      const count = async (table: typeof posLocations | typeof posItems | typeof posProducts, mapped?: 'site' | 'item') => {
        const where = and(eq(table.connectionId, c.id), isNull(table.deletedAt));
        const [r] = await tx
          .select({
            n: sql<number>`count(*)::int`,
            mapped: mapped === 'site' ? sql<number>`count(${posLocations.siteId})::int` : mapped === 'item' ? sql<number>`count(${posItems.itemId})::int` : sql<number>`0`,
          })
          .from(table)
          .where(where);
        return r!;
      };
      const [locs, its, prods] = await Promise.all([count(posLocations, 'site'), count(posItems, 'item'), count(posProducts)]);
      const pushes = await tx.select({ status: posPushes.status, n: sql<number>`count(*)::int` }).from(posPushes).where(eq(posPushes.connectionId, c.id)).groupBy(posPushes.status);
      const [orders] = await tx.select({ n: sql<number>`count(*)::int`, last: sql<string | null>`max(${posOrders.businessDate})` }).from(posOrders).where(eq(posOrders.connectionId, c.id));
      const { tokenSealed: _t, ...safe } = c;
      return {
        ...base,
        connected: true as const,
        connection: safe,
        locations: { total: locs.n, mapped: locs.mapped },
        items: { total: its.n, mapped: its.mapped },
        products: prods.n,
        orders: { imported: orders?.n ?? 0, lastBusinessDate: orders?.last ?? null },
        pushes: Object.fromEntries(pushes.map((p) => [p.status, p.n])),
      };
    });
  }

  /** Start connecting: a one-time state and the Foodics page where the owner approves Backhouse. */
  async connect(a: AccessContext) {
    this.must(a, 'pos:manage');
    return this.db.tenant(a.tenant, async (tx) => {
      if (await this.live(tx)) throw new ConflictException('Foodics is already connected');
      const state = randomBytes(24).toString('hex');
      await tx.delete(posOauthStates).where(lte(posOauthStates.expiresAt, new Date()));
      await tx.insert(posOauthStates).values({ state, orgId: a.orgId, userId: a.userId, provider: PROVIDER, expiresAt: new Date(Date.now() + STATE_TTL_MS) });
      return { url: this.api.authorizeUrl(state), mode: this.mode };
    });
  }

  /**
   * Foodics sent the owner back with a code. Foodics requires the business to be signed in to
   * Backhouse before the token is created: this runs in the signed-in person's session, and the
   * state must be the one this person started.
   */
  async callback(a: AccessContext, code: string, state: string) {
    this.must(a, 'pos:manage');
    const st = await this.db.tenant(a.tenant, async (tx) => {
      const [row] = await tx.delete(posOauthStates).where(eq(posOauthStates.state, state)).returning();
      return row;
    });
    if (!st || st.userId !== a.userId || st.provider !== PROVIDER) throw new BadRequestException('This connection link is not valid. Start again from Integrations.');
    if (st.expiresAt.getTime() < Date.now()) throw new BadRequestException('This connection link has expired. Start again from Integrations.');
    let token: string;
    try {
      token = await this.api.exchangeCode(code);
    } catch (e) {
      throw new BadRequestException(`Foodics didn't accept the connection: ${(e as Error).message}`);
    }
    const who = await this.api.whoami(token);
    const settings = await this.api.settings(token).catch(() => ({ currency: null, timezone: null }));
    const reference = String(who.business.reference);
    try {
      const conn = await this.db.tenant(a.tenant, async (tx) => {
        if (await this.live(tx)) throw new ConflictException('Foodics is already connected');
        const [c] = await tx
          .insert(posConnections)
          .values({
            orgId: a.orgId,
            provider: PROVIDER,
            businessId: who.business.id,
            businessReference: reference,
            businessName: who.business.name,
            currency: settings.currency,
            timezone: settings.timezone,
            scopes: who.scopes,
            tokenSealed: this.sealer.seal(token),
            importFrom: new Date(Date.now() - HISTORY_DAYS * 86400_000).toISOString().slice(0, 10),
            connectedBy: a.userId,
          })
          .returning();
        await audit(tx, a, { action: 'integration.connected', entityType: 'pos_connection', entityId: c!.id, after: { provider: PROVIDER, business: who.business.name, reference } });
        return c!;
      });
      const { tokenSealed: _t, ...safe } = conn;
      return safe;
    } catch (e) {
      if ((e as { code?: string }).code === '23505') {
        await this.api.revoke(token).catch(() => undefined);
        throw new ConflictException('This Foodics account is already connected to another Backhouse organisation');
      }
      throw e;
    }
  }

  async update(a: AccessContext, dto: { pushPurchases?: boolean; importFrom?: string | null }) {
    this.must(a, 'pos:manage');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      const [after] = await tx
        .update(posConnections)
        .set({ pushPurchases: dto.pushPurchases ?? c.pushPurchases, importFrom: dto.importFrom === undefined ? c.importFrom : dto.importFrom, updatedAt: new Date() })
        .where(eq(posConnections.id, c.id))
        .returning();
      await audit(tx, a, { action: 'integration.updated', entityType: 'pos_connection', entityId: c.id, before: { pushPurchases: c.pushPurchases, importFrom: c.importFrom }, after: dto });
      const { tokenSealed: _t, ...safe } = after!;
      return safe;
    });
  }

  /** Disconnect: revoke the token at Foodics (best effort) and forget it. Imported data stays. */
  async disconnect(a: AccessContext) {
    this.must(a, 'pos:manage');
    const c = await this.db.tenant(a.tenant, (tx) => this.mustLive(tx));
    if (c.tokenSealed) await this.api.revoke(this.token(c)).catch((e) => this.logger.warn(`revoke failed: ${(e as Error).message}`));
    await this.db.tenant(a.tenant, async (tx) => {
      await tx.update(posConnections).set({ status: 'disconnected', tokenSealed: null, disconnectedAt: new Date(), updatedAt: new Date() }).where(eq(posConnections.id, c.id));
      await audit(tx, a, { action: 'integration.disconnected', entityType: 'pos_connection', entityId: c.id, before: { status: c.status } });
    });
    return { disconnected: true };
  }

  // ---------- syncing ----------

  /** Sync now (a person asked): catalogue, then new orders, then purchases waiting to be recorded. */
  async syncNow(a: AccessContext) {
    this.must(a, 'pos:manage');
    const c = await this.db.tenant(a.tenant, (tx) => this.mustLive(tx));
    const catalog = await this.syncCatalog(c);
    const orders = await this.importOrders(c, 20);
    const pushes = await this.pushDue(c);
    return { catalog, orders, pushes };
  }

  private tenantFor(c: Conn) {
    return { orgId: c.orgId, userId: c.connectedBy ?? c.orgId };
  }

  /** Branches, warehouses, inventory items and menu products; new ones are matched to ours by name. */
  async syncCatalog(c: Conn) {
    const [branches, warehouses, invItems, products] = await this.call(c, async (t) => [await this.api.branches(t), await this.api.warehouses(t), await this.api.inventoryItems(t), await this.api.products(t)] as const);
    return this.db.tenant(this.tenantFor(c), async (tx) => {
      const now = new Date();
      // Locations
      const ourSites = await tx.select({ id: sites.id, name: sites.name, nameAr: sites.nameAr }).from(sites).where(eq(sites.isActive, true));
      const existingLocs = await tx.select().from(posLocations).where(eq(posLocations.connectionId, c.id));
      const taken = new Set(existingLocs.filter((l) => l.siteId && !l.deletedAt).map((l) => l.siteId));
      const locs: (FoodicsBranch & { kind: string })[] = [...branches.map((b) => ({ ...b, kind: 'branch' })), ...warehouses.map((w) => ({ ...w, kind: 'warehouse' }))];
      let autoSites = 0;
      for (const b of locs) {
        const prev = existingLocs.find((l) => l.externalId === b.id);
        let siteId = prev?.siteId ?? null;
        let mappedBy = prev?.mappedBy ?? null;
        if (!siteId && !b.deleted_at) {
          const m = bestNameMatch(b.name, b.name_localized ?? null, ourSites.filter((s) => !taken.has(s.id)), 0.6);
          if (m) {
            siteId = m.item.id;
            mappedBy = 'auto';
            taken.add(siteId);
            autoSites++;
          }
        }
        await tx
          .insert(posLocations)
          .values({ orgId: c.orgId, connectionId: c.id, externalId: b.id, kind: b.kind, name: b.name, nameAr: b.name_localized ?? null, reference: b.reference ?? null, siteId, mappedBy, deletedAt: b.deleted_at ? now : null })
          .onConflictDoUpdate({ target: [posLocations.connectionId, posLocations.externalId], set: { name: b.name, nameAr: b.name_localized ?? null, reference: b.reference ?? null, kind: b.kind, siteId, mappedBy, deletedAt: b.deleted_at ? now : null } });
      }
      const seenLocs = new Set(locs.map((l) => l.id));
      for (const l of existingLocs) if (!seenLocs.has(l.externalId) && !l.deletedAt) await tx.update(posLocations).set({ deletedAt: now }).where(eq(posLocations.id, l.id));

      // Inventory items: same SKU as our item code first, then a confident name match.
      const ours = await tx.select({ id: items.id, name: items.name, nameAr: items.nameAr, code: items.code }).from(items).where(and(eq(items.isActive, true), eq(items.isStockable, true)));
      const existingItems = await tx.select().from(posItems).where(eq(posItems.connectionId, c.id));
      const mappedItems = new Set(existingItems.filter((i) => i.itemId && !i.deletedAt).map((i) => i.itemId));
      let autoItems = 0;
      for (const it of invItems) {
        const prev = existingItems.find((i) => i.externalId === it.id);
        let itemId = prev?.itemId ?? null;
        let mappedBy = prev?.mappedBy ?? null;
        if (!itemId && !it.deleted_at) {
          const free = ours.filter((o) => !mappedItems.has(o.id));
          const bySku = it.sku ? free.find((o) => o.code && o.code.toLowerCase() === it.sku!.toLowerCase()) : undefined;
          const m = bySku ? { item: bySku } : bestNameMatch(it.name, it.name_localized ?? null, free, 0.75);
          if (m) {
            itemId = m.item.id;
            mappedBy = 'auto';
            mappedItems.add(itemId);
            autoItems++;
          }
        }
        const values = {
          sku: it.sku ?? null,
          name: it.name,
          nameAr: it.name_localized ?? null,
          storageUnit: it.storage_unit ?? null,
          ingredientUnit: it.ingredient_unit ?? null,
          storageFactor: it.storage_to_ingredient_factor !== null && it.storage_to_ingredient_factor !== undefined ? String(it.storage_to_ingredient_factor) : null,
          itemId,
          mappedBy,
          deletedAt: it.deleted_at ? now : null,
        };
        await tx.insert(posItems).values({ orgId: c.orgId, connectionId: c.id, externalId: it.id, ...values }).onConflictDoUpdate({ target: [posItems.connectionId, posItems.externalId], set: values });
      }
      const seenItems = new Set(invItems.map((i) => i.id));
      for (const i of existingItems) if (!seenItems.has(i.externalId) && !i.deletedAt) await tx.update(posItems).set({ deletedAt: now }).where(eq(posItems.id, i.id));

      // Menu products, with Foodics' own recipe when it keeps one.
      for (const p of products) {
        const values = {
          sku: p.sku ?? null,
          name: p.name,
          nameAr: p.name_localized ?? null,
          category: p.category?.name ?? null,
          price: p.price !== null && p.price !== undefined ? String(p.price) : null,
          isActive: p.is_active !== false,
          posIngredients: (p.ingredients ?? []).map((i) => ({ externalItemId: i.id, quantity: Number(i.pivot?.quantity ?? 0) })),
          deletedAt: p.deleted_at ? now : null,
        };
        await tx.insert(posProducts).values({ orgId: c.orgId, connectionId: c.id, externalId: p.id, ...values }).onConflictDoUpdate({ target: [posProducts.connectionId, posProducts.externalId], set: values });
      }
      await tx.update(posConnections).set({ catalogSyncedAt: now, needsSync: false, lastError: null, updatedAt: now }).where(eq(posConnections.id, c.id));
      return { locations: locs.length, items: invItems.length, products: products.length, autoMatchedSites: autoSites, autoMatchedItems: autoItems };
    });
  }

  /** Add an order's sales (replacing what an earlier version of it added). */
  private async upsertOrder(tx: Tx, c: Conn, o: FoodicsOrder) {
    const lines = orderSalesLines(o);
    const location = o.branch?.id ?? 'unknown';
    const [prev] = await tx.select().from(posOrders).where(and(eq(posOrders.connectionId, c.id), eq(posOrders.externalId, o.id))).for('update');
    const apply = async (date: string, loc: string, ls: { productId: string; qty: string; net: string }[], sign: 1 | -1) => {
      for (const l of ls) {
        const qty = new Decimal(l.qty).mul(sign).toFixed(3);
        const net = new Decimal(l.net).mul(sign).toFixed(2);
        await tx
          .insert(posSalesDaily)
          .values({ orgId: c.orgId, connectionId: c.id, locationExternalId: loc, productExternalId: l.productId, businessDate: date, qty, net, orders: sign })
          .onConflictDoUpdate({
            target: [posSalesDaily.connectionId, posSalesDaily.locationExternalId, posSalesDaily.productExternalId, posSalesDaily.businessDate],
            set: { qty: sql`${posSalesDaily.qty} + ${qty}::numeric`, net: sql`${posSalesDaily.net} + ${net}::numeric`, orders: sql`${posSalesDaily.orders} + ${sign}` },
          });
      }
    };
    if (prev) await apply(prev.businessDate, prev.locationExternalId ?? 'unknown', prev.lines, -1);
    await apply(o.business_date, location, lines, 1);
    const values = {
      reference: o.reference !== null && o.reference !== undefined ? Number(o.reference) : null,
      locationExternalId: location,
      businessDate: o.business_date,
      status: o.status,
      totalPrice: o.total_price !== null && o.total_price !== undefined ? String(o.total_price) : null,
      lines,
      importedAt: new Date(),
    };
    if (prev) await tx.update(posOrders).set(values).where(eq(posOrders.id, prev.id));
    else await tx.insert(posOrders).values({ orgId: c.orgId, connectionId: c.id, externalId: o.id, ...values });
  }

  /**
   * New orders in reference order (Foodics' recommended paging), then orders changed since the last
   * import (returns after closing). Each Foodics request is one unit of budget.
   */
  async importOrders(c: Conn, budget = 10) {
    let imported = 0;
    let updated = 0;
    let last = c.lastOrderReference;
    let requests = 0;
    const startedAt = new Date();
    while (requests < budget) {
      const page = await this.call(c, (t) => this.api.ordersAfter(t, last, last === 0 && c.importFrom ? { businessDateAfter: c.importFrom } : {}));
      requests++;
      if (!page.length) break;
      await this.db.tenant(this.tenantFor(c), async (tx) => {
        for (const o of page) {
          if (!c.importFrom || o.business_date >= c.importFrom) await this.upsertOrder(tx, c, o);
          last = Math.max(last, Number(o.reference ?? 0));
          imported++;
        }
        await tx.update(posConnections).set({ lastOrderReference: last, updatedAt: new Date() }).where(eq(posConnections.id, c.id));
      });
      if (page.length < 50) break;
    }
    if (c.ordersSyncedAt && requests < budget) {
      // Foodics allows at most 10 pages when paging this way.
      for (let p = 1; p <= 10 && requests < budget; p++) {
        const r = await this.call(c, (t) => this.api.ordersUpdatedAfter(t, new Date(c.ordersSyncedAt!.getTime() - 5 * 60_000), p));
        requests++;
        await this.db.tenant(this.tenantFor(c), async (tx) => {
          for (const o of r.orders) {
            if (Number(o.reference ?? 0) > last) continue; // picked up by the reference pass next time
            await this.upsertOrder(tx, c, o);
            updated++;
          }
        });
        if (p >= r.lastPage) break;
      }
    }
    await this.db.tenant(this.tenantFor(c), (tx) => tx.update(posConnections).set({ ordersSyncedAt: startedAt, updatedAt: new Date() }).where(eq(posConnections.id, c.id)));
    return { imported, updated, lastReference: last, requests };
  }

  // ---------- recording purchases in Foodics ----------

  /** The Backhouse supplier and user in Foodics, created once per business (Foodics' guide asks for both). */
  private async ensureIdentity(c: Conn): Promise<Conn> {
    let next = c;
    if (!c.posSupplierId) {
      if (!c.scopes.includes('inventory.settings.write')) throw new Error('Foodics did not grant inventory.settings.write (needed to create the Backhouse supplier)');
      const s = await this.call(c, (t) => this.api.createSupplier(t, { name: 'Backhouse', code: 'BACKHOUSE' }));
      next = { ...next, posSupplierId: s.id };
    }
    if (!c.posUserId) {
      if (!c.scopes.includes('users.write')) throw new Error('Foodics did not grant users.write (needed to create the Backhouse user)');
      const u = await this.call(c, (t) => this.api.createUser(t, { name: 'Backhouse', pin: String(randomInt(100000, 999999)), lang: 'en' }));
      next = { ...next, posUserId: u.id };
    }
    if (next !== c) await this.db.tenant(this.tenantFor(c), (tx) => tx.update(posConnections).set({ posSupplierId: next.posSupplierId, posUserId: next.posUserId, updatedAt: new Date() }).where(eq(posConnections.id, c.id)));
    return next;
  }

  /** Queue goods receipts at mapped sites (received since connecting) and record what's ready. */
  async pushDue(c: Conn) {
    if (!c.pushPurchases) return { pushed: 0, needsMapping: 0, failed: 0 };
    const work = await this.db.tenant(this.tenantFor(c), async (tx) => {
      const mapped = await tx.select().from(posLocations).where(and(eq(posLocations.connectionId, c.id), isNotNull(posLocations.siteId), isNull(posLocations.deletedAt)));
      const siteIds = mapped.map((l) => l.siteId!);
      if (siteIds.length) {
        const fresh = await tx
          .select({ id: goodsReceipts.id })
          .from(goodsReceipts)
          .leftJoin(posPushes, and(eq(posPushes.connectionId, c.id), eq(posPushes.sourceType, 'goods_receipt'), eq(posPushes.sourceId, goodsReceipts.id)))
          .where(and(inArray(goodsReceipts.siteId, siteIds), gte(goodsReceipts.receivedAt, c.connectedAt), isNull(posPushes.id)));
        if (fresh.length) await tx.insert(posPushes).values(fresh.map((g) => ({ orgId: c.orgId, connectionId: c.id, sourceType: 'goods_receipt', sourceId: g.id }))).onConflictDoNothing();
      }
      return tx
        .select()
        .from(posPushes)
        .where(and(eq(posPushes.connectionId, c.id), inArray(posPushes.status, ['pending', 'needs_mapping', 'failed']), lte(posPushes.attempts, MAX_PUSH_ATTEMPTS - 1)))
        .orderBy(asc(posPushes.createdAt))
        .limit(25);
    });
    const out = { pushed: 0, needsMapping: 0, failed: 0 };
    let conn = c;
    for (const p of work) {
      const r = await this.pushReceipt(conn, p.id, p.sourceId).catch((e: Error) => ({ status: 'failed' as const, error: e.message }));
      if (r.status === 'pushed') out.pushed++;
      else if (r.status === 'needs_mapping') out.needsMapping++;
      else out.failed++;
      if (r.status === 'pushed' && 'conn' in r) conn = r.conn;
    }
    return out;
  }

  /** One goods receipt → a closed Foodics purchasing transaction (type 1, status 4). */
  private async pushReceipt(c: Conn, pushId: string, receiptId: string): Promise<{ status: 'pushed'; conn: Conn } | { status: 'needs_mapping' | 'failed'; error?: string }> {
    const prepared = await this.db.tenant(this.tenantFor(c), async (tx) => {
      const [g] = await tx.select().from(goodsReceipts).where(eq(goodsReceipts.id, receiptId));
      if (!g) return { kind: 'gone' as const };
      const [po] = await tx.select({ number: purchaseOrders.number, taxRate: purchaseOrders.taxRate }).from(purchaseOrders).where(eq(purchaseOrders.id, g.poId));
      const [loc] = await tx.select().from(posLocations).where(and(eq(posLocations.connectionId, c.id), eq(posLocations.siteId, g.siteId), isNull(posLocations.deletedAt)));
      const lines = await tx.select({ l: goodsReceiptLines, name: items.name, baseUnit: items.baseUnit }).from(goodsReceiptLines).innerJoin(items, eq(items.id, goodsReceiptLines.itemId)).where(eq(goodsReceiptLines.receiptId, g.id));
      const maps = lines.length ? await tx.select().from(posItems).where(and(eq(posItems.connectionId, c.id), inArray(posItems.itemId, lines.map((x) => x.l.itemId)), isNull(posItems.deletedAt))) : [];
      const byItem = new Map<string, { posItemId: string; qty: Decimal; cost: Decimal }>();
      const missing: string[] = [];
      for (const { l, name, baseUnit } of lines) {
        const m = maps.find((x) => x.itemId === l.itemId);
        const qty = m ? toPosStorageQty(l.qtyBase, baseUnit, { ingredientUnit: m.ingredientUnit, storageFactor: m.storageFactor, manualFactor: m.manualFactor }) : null;
        if (!m || !qty) {
          missing.push(m ? `${name} (units don't match: set how much is in one ${m.storageUnit ?? 'unit'})` : name);
          continue;
        }
        const cur = byItem.get(m.externalId) ?? { posItemId: m.externalId, qty: new Decimal(0), cost: new Decimal(0) };
        byItem.set(m.externalId, { ...cur, qty: cur.qty.plus(qty), cost: cur.cost.plus(new Decimal(l.qty).mul(l.unitPrice)) });
      }
      return { kind: 'ok' as const, g, po, loc, lines: [...byItem.values()], missing };
    });
    const setPush = (values: Partial<typeof posPushes.$inferInsert>) =>
      this.db.tenant(this.tenantFor(c), (tx) => tx.update(posPushes).set({ ...values, updatedAt: new Date() }).where(eq(posPushes.id, pushId)));
    if (prepared.kind === 'gone' || !prepared.loc) {
      await setPush({ status: 'skipped', error: prepared.kind === 'gone' ? 'Goods receipt not found' : 'The site is no longer mapped to a Foodics branch' });
      return { status: 'failed', error: 'skipped' };
    }
    if (prepared.missing.length || !prepared.lines.length) {
      const error = prepared.missing.length ? `Map these items to Foodics: ${prepared.missing.join(', ')}` : 'Nothing to record';
      await setPush({ status: 'needs_mapping', error, detail: { missing: prepared.missing } });
      return { status: 'needs_mapping', error };
    }
    const { g, po, loc, lines } = prepared;
    const subtotal = lines.reduce((s, l) => s.plus(l.cost), new Decimal(0));
    const body = {
      type: 1,
      status: 4,
      branch_id: loc.externalId,
      supplier_id: '',
      creator_id: undefined as string | undefined,
      poster_id: undefined as string | undefined,
      invoice_number: g.documentNo ?? g.number,
      invoice_date: g.receivedAt.toISOString().slice(0, 10),
      paid_tax: Number(subtotal.mul(po?.taxRate ?? 0).toFixed(2)),
      additional_cost: 0,
      notes: `Backhouse ${g.number}${po ? ` · ${po.number}` : ''}`,
      items: lines.map((l) => ({ id: l.posItemId, quantity: Number(l.qty.toFixed(4)), cost: Number(l.cost.toFixed(2)) })),
    };
    try {
      const conn = await this.ensureIdentity(c);
      body.supplier_id = conn.posSupplierId!;
      body.creator_id = conn.posUserId ?? undefined;
      body.poster_id = conn.posUserId ?? undefined;
      const r = await this.call(conn, (t) => this.api.createInventoryTransaction(t, body));
      await setPush({ status: 'pushed', externalId: r.id, externalReference: r.reference, error: null, detail: body, attempts: sql`${posPushes.attempts} + 1` as unknown as number });
      return { status: 'pushed', conn };
    } catch (e) {
      const error = (e as Error).message;
      await setPush({ status: 'failed', error, detail: body, attempts: sql`${posPushes.attempts} + 1` as unknown as number });
      return { status: 'failed', error };
    }
  }

  // ---------- webhooks and the worker ----------

  /**
   * Foodics webhook. Foodics needs a 2xx within 5 seconds and doesn't sign webhooks, so we only
   * record which business it's about and pull the changes through the API ourselves.
   */
  async receiveWebhook(body: unknown) {
    const b = (body ?? {}) as { event?: unknown; business?: { reference?: unknown }; order?: { id?: unknown } };
    const event = typeof b.event === 'string' ? b.event.slice(0, 60) : 'unknown';
    const reference = b.business?.reference !== undefined && b.business?.reference !== null ? String(b.business.reference).slice(0, 40) : null;
    const objectId = typeof b.order?.id === 'string' ? b.order.id.slice(0, 80) : null;
    await this.db.system((tx) => tx.insert(posWebhookEvents).values({ provider: PROVIDER, event, businessReference: reference, objectId }));
    // Handle it after replying; the worker picks up anything left.
    setImmediate(() => void this.processWebhooks().catch((e) => this.logger.warn(`webhook processing: ${(e as Error).message}`)));
    return { received: true };
  }

  private processing: Promise<number> | null = null;
  /** Act on recorded webhooks: order events pull new orders, menu changes refresh the catalogue. */
  processWebhooks(): Promise<number> {
    this.processing ??= this.doProcessWebhooks().finally(() => (this.processing = null));
    return this.processing;
  }
  private async doProcessWebhooks() {
    const pending = await this.db.system((tx) => tx.select().from(posWebhookEvents).where(and(eq(posWebhookEvents.provider, PROVIDER), isNull(posWebhookEvents.processedAt))).orderBy(asc(posWebhookEvents.id)).limit(500));
    if (!pending.length) return 0;
    const refs = [...new Set(pending.map((p) => p.businessReference).filter((r): r is string => !!r))];
    const conns = refs.length ? await this.db.system((tx) => tx.select().from(posConnections).where(and(eq(posConnections.provider, PROVIDER), eq(posConnections.status, 'connected'), inArray(posConnections.businessReference, refs)))) : [];
    for (const ref of [null, ...refs]) {
      const events = pending.filter((p) => p.businessReference === ref);
      if (!events.length) continue;
      const c = conns.find((x) => x.businessReference === ref);
      let outcome = 'no connection';
      if (c) {
        try {
          if (events.some((e) => e.event === 'menu.updated')) await this.db.system((tx) => tx.update(posConnections).set({ needsSync: true }).where(eq(posConnections.id, c.id)));
          if (events.some((e) => e.event.startsWith('order.') || e.event.startsWith('customer.order.'))) await this.importOrders(c, 3);
          outcome = 'ok';
        } catch (e) {
          outcome = `error: ${(e as Error).message}`.slice(0, 300);
        }
      }
      await this.db.system((tx) => tx.update(posWebhookEvents).set({ processedAt: new Date(), outcome, orgId: c?.orgId ?? null }).where(inArray(posWebhookEvents.id, events.map((e) => e.id))));
    }
    return pending.length;
  }

  /** Worker tick: webhooks, catalogue refresh, order import and purchase recording for every connection. */
  async runDue() {
    await this.processWebhooks();
    const conns = await this.db.system((tx) => tx.select().from(posConnections).where(and(eq(posConnections.provider, PROVIDER), eq(posConnections.status, 'connected'))));
    const out = { catalogs: 0, orders: 0, pushed: 0 };
    for (const c of conns) {
      try {
        if (c.needsSync || !c.catalogSyncedAt || Date.now() - c.catalogSyncedAt.getTime() > CATALOG_EVERY_MS) {
          await this.syncCatalog(c);
          out.catalogs++;
        }
        if (!c.ordersSyncedAt || Date.now() - c.ordersSyncedAt.getTime() > ORDERS_EVERY_MS) out.orders += (await this.importOrders(c, 10)).imported;
        out.pushed += (await this.pushDue(c)).pushed;
      } catch (e) {
        const msg = (e as Error).message;
        this.logger.warn(`foodics ${c.businessReference}: ${msg}`);
        await this.db.system((tx) => tx.update(posConnections).set({ lastError: msg.slice(0, 500), updatedAt: new Date() }).where(eq(posConnections.id, c.id)));
      }
    }
    return out;
  }

  // ---------- mapping and reading ----------

  async locations(a: AccessContext) {
    this.must(a, 'pos:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      return tx
        .select({ l: posLocations, siteName: sites.name, siteNameAr: sites.nameAr })
        .from(posLocations)
        .leftJoin(sites, eq(sites.id, posLocations.siteId))
        .where(and(eq(posLocations.connectionId, c.id), isNull(posLocations.deletedAt)))
        .orderBy(asc(posLocations.kind), asc(posLocations.name))
        .then((rows) => rows.map(({ l, ...r }) => ({ ...l, ...r })));
    });
  }

  async mapLocation(a: AccessContext, id: string, siteId: string | null) {
    this.must(a, 'pos:manage');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      const [loc] = await tx.select().from(posLocations).where(and(eq(posLocations.id, id), eq(posLocations.connectionId, c.id)));
      if (!loc) throw new NotFoundException('location not found');
      if (siteId) {
        const [site] = await tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
        if (!site) throw new NotFoundException('site not found');
        const [other] = await tx.select({ id: posLocations.id, name: posLocations.name }).from(posLocations).where(and(eq(posLocations.connectionId, c.id), eq(posLocations.siteId, siteId), ne(posLocations.id, id), isNull(posLocations.deletedAt)));
        if (other) throw new ConflictException(`That site is already linked to ${other.name}`);
      }
      const [after] = await tx.update(posLocations).set({ siteId, mappedBy: siteId ? 'human' : null }).where(eq(posLocations.id, id)).returning();
      await audit(tx, a, { action: 'integration.location_mapped', entityType: 'pos_location', entityId: id, before: { siteId: loc.siteId }, after: { siteId } });
      return after;
    });
  }

  async posItemsList(a: AccessContext, filter: 'all' | 'unmapped') {
    this.must(a, 'pos:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      const rows = await tx
        .select({ p: posItems, itemName: items.name, itemNameAr: items.nameAr, baseUnit: items.baseUnit })
        .from(posItems)
        .leftJoin(items, eq(items.id, posItems.itemId))
        .where(and(eq(posItems.connectionId, c.id), isNull(posItems.deletedAt), filter === 'unmapped' ? isNull(posItems.itemId) : undefined))
        .orderBy(asc(posItems.name));
      const ours = filter === 'all' || rows.some((r) => !r.p.itemId) ? await tx.select({ id: items.id, name: items.name, nameAr: items.nameAr }).from(items).where(and(eq(items.isActive, true), eq(items.isStockable, true))) : [];
      return rows.map(({ p, itemName, itemNameAr, baseUnit }) => {
        const suggestion = !p.itemId ? bestNameMatch(p.name, p.nameAr, ours, 0.5) : null;
        const inBase = baseUnit ? posStorageInBase(baseUnit, { ingredientUnit: p.ingredientUnit, storageFactor: p.storageFactor, manualFactor: p.manualFactor }) : null;
        return {
          ...p,
          itemName,
          itemNameAr,
          baseUnit,
          /** Our base units in one Foodics storage unit; null means the units don't line up yet. */
          storageInBase: inBase ? inBase.toFixed(6) : null,
          suggestion: suggestion ? { itemId: suggestion.item.id, name: suggestion.item.name, nameAr: suggestion.item.nameAr, score: Math.round(suggestion.score * 100) / 100 } : null,
        };
      });
    });
  }

  async mapItem(a: AccessContext, id: string, dto: { itemId: string | null; manualFactor?: number | null }) {
    this.must(a, 'pos:manage');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      const [p] = await tx.select().from(posItems).where(and(eq(posItems.id, id), eq(posItems.connectionId, c.id)));
      if (!p) throw new NotFoundException('Foodics item not found');
      if (dto.itemId) {
        const [it] = await tx.select({ id: items.id, isStockable: items.isStockable }).from(items).where(eq(items.id, dto.itemId));
        if (!it) throw new NotFoundException('item not found');
        const [other] = await tx.select({ name: posItems.name }).from(posItems).where(and(eq(posItems.connectionId, c.id), eq(posItems.itemId, dto.itemId), ne(posItems.id, id), isNull(posItems.deletedAt)));
        if (other) throw new ConflictException(`That item is already linked to ${other.name} in Foodics`);
      }
      const manualFactor = dto.manualFactor === undefined ? p.manualFactor : dto.manualFactor === null ? null : new Decimal(dto.manualFactor).toFixed(6);
      const [after] = await tx.update(posItems).set({ itemId: dto.itemId, mappedBy: dto.itemId ? 'human' : null, manualFactor }).where(eq(posItems.id, id)).returning();
      // Purchases waiting on this mapping can be tried again.
      await tx.update(posPushes).set({ status: 'pending', updatedAt: new Date() }).where(and(eq(posPushes.connectionId, c.id), eq(posPushes.status, 'needs_mapping')));
      await audit(tx, a, { action: 'integration.item_mapped', entityType: 'pos_item', entityId: id, before: { itemId: p.itemId, manualFactor: p.manualFactor }, after: { itemId: dto.itemId, manualFactor } });
      return after;
    });
  }

  async productsList(a: AccessContext, days = 7) {
    this.must(a, 'pos:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      const from = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
      const sold = await tx
        .select({ productId: posSalesDaily.productExternalId, qty: sql<string>`sum(${posSalesDaily.qty})::text`, net: sql<string>`sum(${posSalesDaily.net})::text` })
        .from(posSalesDaily)
        .where(and(eq(posSalesDaily.connectionId, c.id), gte(posSalesDaily.businessDate, from)))
        .groupBy(posSalesDaily.productExternalId);
      const rows = await tx.select().from(posProducts).where(and(eq(posProducts.connectionId, c.id), isNull(posProducts.deletedAt))).orderBy(asc(posProducts.category), asc(posProducts.name));
      return rows.map((p) => {
        const s = sold.find((x) => x.productId === p.externalId);
        return { ...p, soldQty: s?.qty ?? '0', soldNet: a.can('price:read') ? (s?.net ?? '0') : undefined, hasPosRecipe: (p.posIngredients ?? []).length > 0 };
      });
    });
  }

  /** Sales by day and site (mapped locations), and the top products, for a period. */
  async sales(a: AccessContext, q: { from: string; to: string; siteId?: string }) {
    this.must(a, 'pos:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      const locs = await tx.select().from(posLocations).where(eq(posLocations.connectionId, c.id));
      const ids = q.siteId ? locs.filter((l) => l.siteId === q.siteId).map((l) => l.externalId) : null;
      if (ids && !ids.length) return { days: [], products: [], total: { qty: '0', net: '0' } };
      const where = and(eq(posSalesDaily.connectionId, c.id), gte(posSalesDaily.businessDate, q.from), lte(posSalesDaily.businessDate, q.to), ids ? inArray(posSalesDaily.locationExternalId, ids) : undefined);
      const byDay = await tx
        .select({ date: posSalesDaily.businessDate, location: posSalesDaily.locationExternalId, qty: sql<string>`sum(${posSalesDaily.qty})::text`, net: sql<string>`sum(${posSalesDaily.net})::text` })
        .from(posSalesDaily)
        .where(where)
        .groupBy(posSalesDaily.businessDate, posSalesDaily.locationExternalId)
        .orderBy(desc(posSalesDaily.businessDate));
      const byProduct = await tx
        .select({ productId: posSalesDaily.productExternalId, name: posProducts.name, nameAr: posProducts.nameAr, qty: sql<string>`sum(${posSalesDaily.qty})::text`, net: sql<string>`sum(${posSalesDaily.net})::text` })
        .from(posSalesDaily)
        .leftJoin(posProducts, and(eq(posProducts.connectionId, posSalesDaily.connectionId), eq(posProducts.externalId, posSalesDaily.productExternalId)))
        .where(where)
        .groupBy(posSalesDaily.productExternalId, posProducts.name, posProducts.nameAr)
        .orderBy(desc(sql`sum(${posSalesDaily.net})`))
        .limit(20);
      const showMoney = a.can('price:read');
      const total = byDay.reduce((s, d) => ({ qty: s.qty.plus(d.qty), net: s.net.plus(d.net) }), { qty: new Decimal(0), net: new Decimal(0) });
      return {
        days: byDay.map((d) => {
          const l = locs.find((x) => x.externalId === d.location);
          return { ...d, net: showMoney ? new Decimal(d.net).toFixed(2) : undefined, qty: new Decimal(d.qty).toFixed(3), locationName: l?.name ?? null, locationNameAr: l?.nameAr ?? null, siteId: l?.siteId ?? null };
        }),
        products: byProduct.map((p) => ({ ...p, qty: new Decimal(p.qty).toFixed(3), net: showMoney ? new Decimal(p.net).toFixed(2) : undefined })),
        total: { qty: total.qty.toFixed(3), net: showMoney ? total.net.toFixed(2) : undefined },
      };
    });
  }

  async pushes(a: AccessContext) {
    this.must(a, 'pos:read');
    return this.db.tenant(a.tenant, async (tx) => {
      const c = await this.mustLive(tx);
      return tx
        .select({ p: posPushes, grnNumber: goodsReceipts.number, siteName: sites.name, siteNameAr: sites.nameAr, total: goodsReceipts.total, receivedAt: goodsReceipts.receivedAt })
        .from(posPushes)
        .leftJoin(goodsReceipts, eq(goodsReceipts.id, posPushes.sourceId))
        .leftJoin(sites, eq(sites.id, goodsReceipts.siteId))
        .where(eq(posPushes.connectionId, c.id))
        .orderBy(desc(posPushes.createdAt))
        .limit(100)
        .then((rows) => rows.map(({ p, ...r }) => ({ ...p, ...r, total: a.can('price:read') ? r.total : undefined })));
    });
  }

  async retryPush(a: AccessContext, id: string) {
    this.must(a, 'pos:manage');
    const c = await this.db.tenant(a.tenant, async (tx) => {
      const conn = await this.mustLive(tx);
      const [p] = await tx.select().from(posPushes).where(and(eq(posPushes.id, id), eq(posPushes.connectionId, conn.id)));
      if (!p) throw new NotFoundException('not found');
      if (p.status === 'pushed') throw new BadRequestException('Already recorded in Foodics');
      await tx.update(posPushes).set({ status: 'pending', attempts: 0, updatedAt: new Date() }).where(eq(posPushes.id, id));
      return conn;
    });
    await this.pushDue(c);
    return this.db.tenant(a.tenant, async (tx) => (await tx.select().from(posPushes).where(eq(posPushes.id, id)))[0]);
  }
}
