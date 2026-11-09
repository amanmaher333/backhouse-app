import { createHash, randomInt } from 'node:crypto';
import type { AppConfig } from '../../config.js';

/*
 * Foodics API (v5). Two implementations:
 * - HttpFoodics: the real API, sandbox or production (https://api[-sandbox].foodics.com/v5).
 * - SimulatedFoodics: a built-in demo business, so connecting, syncing, sales import and
 *   purchase recording work end to end (and in tests) without a Foodics account. It is
 *   stateless: everything is derived from the business reference and the date, so the API and
 *   worker processes see the same data.
 *
 * Docs: developers.foodics.com (guides) and apidocs.foodics.com (reference).
 */

export interface FoodicsBranch { id: string; name: string; name_localized?: string | null; reference?: string | null; type?: number; deleted_at?: string | null }
export interface FoodicsInventoryItem {
  id: string;
  sku?: string | null;
  name: string;
  name_localized?: string | null;
  storage_unit?: string | null;
  ingredient_unit?: string | null;
  storage_to_ingredient_factor?: number | null;
  deleted_at?: string | null;
}
export interface FoodicsProduct {
  id: string;
  sku?: string | null;
  name: string;
  name_localized?: string | null;
  price?: number | null;
  is_active?: boolean;
  category?: { name?: string | null } | null;
  ingredients?: { id: string; pivot?: { quantity?: number | null } | null }[] | null;
  deleted_at?: string | null;
}
export interface FoodicsOrderProduct {
  product?: { id: string } | null;
  quantity?: number | null;
  returned_quantity?: number | null;
  tax_exclusive_total_price?: number | null;
  total_price?: number | null;
  status?: number | null;
}
export interface FoodicsOrder {
  id: string;
  reference?: string | number | null;
  status: number;
  business_date: string;
  total_price?: number | null;
  branch?: { id: string } | null;
  products?: FoodicsOrderProduct[] | null;
  combos?: { quantity?: number | null; products?: FoodicsOrderProduct[] | null }[] | null;
  updated_at?: string | null;
}
export interface FoodicsWhoami {
  scopes: string[];
  business: { id: string; name: string; reference: number | string; country_iso_code?: string | null };
}
export interface InventoryTransactionInput {
  type: number;
  status: number;
  branch_id: string;
  supplier_id: string;
  creator_id?: string;
  poster_id?: string;
  invoice_number?: string | null;
  invoice_date?: string | null;
  paid_tax?: number;
  additional_cost?: number;
  notes?: string;
  items: { id: string; quantity: number; cost: number }[];
}

export interface FoodicsApi {
  readonly mode: 'simulated' | 'sandbox' | 'production';
  authorizeUrl(state: string): string;
  exchangeCode(code: string): Promise<string>;
  whoami(token: string): Promise<FoodicsWhoami>;
  settings(token: string): Promise<{ currency: string | null; timezone: string | null }>;
  branches(token: string): Promise<FoodicsBranch[]>;
  warehouses(token: string): Promise<FoodicsBranch[]>;
  inventoryItems(token: string): Promise<FoodicsInventoryItem[]>;
  products(token: string): Promise<FoodicsProduct[]>;
  /** Up to 50 orders after a reference, oldest first (Foodics' recommended way to page orders). */
  ordersAfter(token: string, reference: number, opts?: { businessDateAfter?: string }): Promise<FoodicsOrder[]>;
  /** Orders changed since a time (returns after closing), page by page (Foodics caps this at 10 pages). */
  ordersUpdatedAfter(token: string, since: Date, page: number): Promise<{ orders: FoodicsOrder[]; lastPage: number }>;
  createSupplier(token: string, body: { name: string; code?: string }): Promise<{ id: string }>;
  createUser(token: string, body: { name: string; pin: string; lang?: string }): Promise<{ id: string }>;
  createInventoryTransaction(token: string, body: InventoryTransactionInput): Promise<{ id: string; reference: string | null }>;
  revoke(token: string): Promise<void>;
}

export const FOODICS_API = Symbol('FOODICS_API');

/** Includes needed to read what an order sold. */
const ORDER_INCLUDES = 'branch,products.product,combos.products.product';

export class FoodicsError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** The real API, with Foodics' limit of 30 requests a minute per token respected in-process. */
export class HttpFoodics implements FoodicsApi {
  readonly mode: 'sandbox' | 'production';
  private readonly api: string;
  private readonly console: string;
  private readonly nextSlot = new Map<string, number>();

  constructor(private readonly config: AppConfig) {
    this.mode = config.FOODICS_MODE === 'production' ? 'production' : 'sandbox';
    const sandbox = this.mode === 'sandbox';
    this.api = sandbox ? 'https://api-sandbox.foodics.com' : 'https://api.foodics.com';
    this.console = sandbox ? 'https://console-sandbox.foodics.com' : 'https://console.foodics.com';
  }

  authorizeUrl(state: string) {
    return `${this.console}/authorize?client_id=${encodeURIComponent(this.config.FOODICS_CLIENT_ID ?? '')}&state=${encodeURIComponent(state)}`;
  }

  async exchangeCode(code: string) {
    const res = await fetch(`${this.api}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_id: this.config.FOODICS_CLIENT_ID,
        client_secret: this.config.FOODICS_CLIENT_SECRET,
        redirect_uri: this.config.FOODICS_REDIRECT_URI ?? `${this.config.PUBLIC_WEB_URL}/integrations/foodics/callback`,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; message?: string };
    if (!res.ok || !body.access_token) throw new FoodicsError(body.message ?? `Foodics token request failed (${res.status})`, res.status);
    return body.access_token;
  }

  /** Space requests 2 seconds apart per token (30 a minute); wait and retry once on 429. */
  private async request<T>(token: string, method: string, path: string, body?: unknown, retry = true): Promise<T> {
    const key = createHash('sha256').update(token).digest('hex');
    const now = Date.now();
    const slot = Math.max(now, this.nextSlot.get(key) ?? 0);
    this.nextSlot.set(key, slot + 2000);
    if (slot > now) await new Promise((r) => setTimeout(r, slot - now));
    const res = await fetch(`${this.api}/v5${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && retry) {
      const wait = Number(res.headers.get('retry-after') ?? 60) * 1000;
      await new Promise((r) => setTimeout(r, Math.min(wait, 65_000)));
      return this.request(token, method, path, body, false);
    }
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { data?: unknown; meta?: { last_page?: number }; message?: string }) : {};
    if (!res.ok) throw new FoodicsError(json.message ?? `Foodics ${method} ${path} failed (${res.status})`, res.status);
    return json as T;
  }

  private async all<T>(token: string, path: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= 200; page++) {
      const sep = path.includes('?') ? '&' : '?';
      const r = await this.request<{ data: T[]; meta?: { last_page?: number } }>(token, 'GET', `${path}${sep}page=${page}`);
      out.push(...r.data);
      if (!r.meta?.last_page || page >= r.meta.last_page) break;
    }
    return out;
  }

  async whoami(token: string) {
    return (await this.request<{ data: FoodicsWhoami }>(token, 'GET', '/whoami')).data;
  }
  async settings(token: string) {
    const d = (await this.request<{ data: { business_currency?: { code?: string } | string | null; business_timezone?: string | null } }>(token, 'GET', '/settings')).data;
    const cur = typeof d.business_currency === 'string' ? d.business_currency : (d.business_currency?.code ?? null);
    return { currency: cur, timezone: d.business_timezone ?? null };
  }
  branches(token: string) {
    return this.all<FoodicsBranch>(token, '/branches');
  }
  warehouses(token: string) {
    return this.all<FoodicsBranch>(token, '/warehouses');
  }
  inventoryItems(token: string) {
    return this.all<FoodicsInventoryItem>(token, '/inventory_items');
  }
  products(token: string) {
    return this.all<FoodicsProduct>(token, '/products?include=category,ingredients');
  }
  async ordersAfter(token: string, reference: number, opts: { businessDateAfter?: string } = {}) {
    const q = new URLSearchParams({ sort: 'reference', 'filter[reference_after]': String(reference), include: ORDER_INCLUDES });
    if (opts.businessDateAfter) q.set('filter[business_date_after]', opts.businessDateAfter);
    return (await this.request<{ data: FoodicsOrder[] }>(token, 'GET', `/orders?${q}`)).data;
  }
  async ordersUpdatedAfter(token: string, since: Date, page: number) {
    const q = new URLSearchParams({ 'filter[updated_after]': since.toISOString().slice(0, 19).replace('T', ' '), include: ORDER_INCLUDES, page: String(page) });
    const r = await this.request<{ data: FoodicsOrder[]; meta?: { last_page?: number } }>(token, 'GET', `/orders?${q}`);
    return { orders: r.data, lastPage: r.meta?.last_page ?? 1 };
  }
  async createSupplier(token: string, body: { name: string; code?: string }) {
    return (await this.request<{ data: { id: string } }>(token, 'POST', '/suppliers', body)).data;
  }
  async createUser(token: string, body: { name: string; pin: string; lang?: string }) {
    return (await this.request<{ data: { id: string } }>(token, 'POST', '/users', body)).data;
  }
  async createInventoryTransaction(token: string, body: InventoryTransactionInput) {
    const d = (await this.request<{ data: { id: string; reference?: string | null } }>(token, 'POST', '/inventory_transactions', body)).data;
    return { id: d.id, reference: d.reference ?? null };
  }
  async revoke(token: string) {
    await this.request(token, 'DELETE', '/tokens/client');
  }
}

/* ------------------------------------------------------------------ */

const SIM_SCOPES = [
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
const SIM_ITEMS: FoodicsInventoryItem[] = [
  { id: 'inv-tomato', sku: 'I001', name: 'Tomatoes', name_localized: 'طماطم', storage_unit: 'KG', ingredient_unit: 'Gram', storage_to_ingredient_factor: 1000 },
  { id: 'inv-chicken', sku: 'I002', name: 'Chicken Breast', name_localized: 'صدر دجاج', storage_unit: 'KG', ingredient_unit: 'Gram', storage_to_ingredient_factor: 1000 },
  { id: 'inv-bun', sku: 'I003', name: 'Burger Bun', name_localized: 'خبز برجر', storage_unit: 'Piece', ingredient_unit: 'Piece', storage_to_ingredient_factor: 1 },
  { id: 'inv-eggs', sku: 'I004', name: 'Eggs', name_localized: 'بيض', storage_unit: 'Tray', ingredient_unit: 'Piece', storage_to_ingredient_factor: 30 },
  { id: 'inv-oil', sku: 'I005', name: 'Olive Oil', name_localized: 'زيت زيتون', storage_unit: 'Tin', ingredient_unit: 'Liter', storage_to_ingredient_factor: 5 },
  { id: 'inv-saffron', sku: 'I006', name: 'Saffron', name_localized: 'زعفران', storage_unit: 'Box', ingredient_unit: 'Box', storage_to_ingredient_factor: 1 },
];
const SIM_PRODUCTS: FoodicsProduct[] = [
  { id: 'prd-burger', sku: 'P001', name: 'Chicken Burger', name_localized: 'برجر دجاج', price: 28, is_active: true, category: { name: 'Burgers' }, ingredients: [{ id: 'inv-chicken', pivot: { quantity: 150 } }, { id: 'inv-bun', pivot: { quantity: 1 } }, { id: 'inv-tomato', pivot: { quantity: 30 } }] },
  { id: 'prd-shakshuka', sku: 'P002', name: 'Shakshuka', name_localized: 'شكشوكة', price: 24, is_active: true, category: { name: 'Breakfast' }, ingredients: [{ id: 'inv-eggs', pivot: { quantity: 2 } }, { id: 'inv-tomato', pivot: { quantity: 120 } }, { id: 'inv-oil', pivot: { quantity: 0.02 } }] },
  { id: 'prd-salad', sku: 'P003', name: 'Chicken Salad', name_localized: 'سلطة دجاج', price: 32, is_active: true, category: { name: 'Salads' }, ingredients: [{ id: 'inv-chicken', pivot: { quantity: 120 } }, { id: 'inv-tomato', pivot: { quantity: 80 } }] },
];
const SIM_BRANCHES: FoodicsBranch[] = [
  { id: 'br-olaya', name: 'Olaya Branch', name_localized: 'فرع العليا', reference: 'B01', type: 1 },
  { id: 'br-malqa', name: 'Malqa Branch', name_localized: 'فرع الملقا', reference: 'B02', type: 1 },
];
const SIM_WAREHOUSES: FoodicsBranch[] = [{ id: 'wh-central', name: 'Central Warehouse', name_localized: 'المستودع المركزي', reference: 'W01', type: 2 }];
/** Orders per branch per day in the demo business. */
const SIM_ORDERS_PER_DAY = 12;
const DAY = 86400_000;

/**
 * A demo Foodics business. Token "sim:<reference>". Orders exist for the last 10 days, 12 per
 * branch per day; references are day-number × 1000 + sequence, so they increase with time.
 */
export class SimulatedFoodics implements FoodicsApi {
  readonly mode = 'simulated' as const;
  /** What Backhouse created in the demo business (this process only; for tests and the simulator). */
  readonly created: { kind: string; token: string; body: unknown }[] = [];
  /** Orders a test returned after closing: order id → returned quantity on its first line. */
  readonly returns = new Map<string, number>();

  constructor(private readonly config: AppConfig) {}

  authorizeUrl(state: string) {
    // No Foodics console to visit: come straight back as if the owner approved a demo business.
    const code = `sim-${randomInt(100000, 999999)}`;
    const redirect = this.config.FOODICS_REDIRECT_URI ?? `${this.config.PUBLIC_WEB_URL}/integrations/foodics/callback`;
    return `${redirect}?code=${code}&state=${encodeURIComponent(state)}`;
  }
  async exchangeCode(code: string) {
    if (!/^sim-\d{6}$/.test(code)) throw new FoodicsError('Invalid authorization code', 400);
    return `sim:${code.slice(4)}`;
  }
  private ref(token: string) {
    if (!token.startsWith('sim:')) throw new FoodicsError('Unauthenticated', 401);
    return token.slice(4);
  }
  async whoami(token: string) {
    const ref = this.ref(token);
    return { scopes: SIM_SCOPES, business: { id: `biz-${ref}`, name: `Demo Kitchen ${ref}`, reference: Number(ref), country_iso_code: 'SA' } };
  }
  async settings(token: string) {
    this.ref(token);
    return { currency: 'SAR', timezone: 'Asia/Riyadh' };
  }
  async branches(token: string) {
    this.ref(token);
    return SIM_BRANCHES;
  }
  async warehouses(token: string) {
    this.ref(token);
    return SIM_WAREHOUSES;
  }
  async inventoryItems(token: string) {
    this.ref(token);
    return SIM_ITEMS;
  }
  async products(token: string) {
    this.ref(token);
    return SIM_PRODUCTS;
  }

  /** The demo order with this reference. */
  private order(reference: number): FoodicsOrder | null {
    const day = Math.floor(reference / 1000);
    const seq = reference % 1000;
    if (seq < 1 || seq > SIM_ORDERS_PER_DAY * SIM_BRANCHES.length) return null;
    const branch = SIM_BRANCHES[(seq - 1) % SIM_BRANCHES.length]!;
    // A fixed pattern: every order has a burger; every 2nd a shakshuka; every 3rd two salads; every 6th is void.
    const products: FoodicsOrderProduct[] = [{ product: { id: 'prd-burger' }, quantity: 1, tax_exclusive_total_price: 24.35, status: 3 }];
    if (seq % 2 === 0) products.push({ product: { id: 'prd-shakshuka' }, quantity: 1, tax_exclusive_total_price: 20.87, status: 3 });
    if (seq % 3 === 0) products.push({ product: { id: 'prd-salad' }, quantity: 2, tax_exclusive_total_price: 55.65, status: 3 });
    const id = `ord-${reference}`;
    const returned = this.returns.get(id);
    if (returned) products[0] = { ...products[0]!, returned_quantity: returned };
    const status = seq % 6 === 0 ? 7 : 4;
    const total = products.reduce((s, p) => s + (p.tax_exclusive_total_price ?? 0), 0) * 1.15;
    return { id, reference, status, business_date: new Date(day * DAY).toISOString().slice(0, 10), total_price: Math.round(total * 100) / 100, branch: { id: branch.id }, products, updated_at: new Date().toISOString() };
  }

  async ordersAfter(token: string, reference: number, opts: { businessDateAfter?: string } = {}) {
    this.ref(token);
    const today = Math.floor(Date.now() / DAY);
    const firstDay = Math.max(today - 9, opts.businessDateAfter ? Math.floor(Date.parse(opts.businessDateAfter) / DAY) : 0);
    const out: FoodicsOrder[] = [];
    let day = Math.max(firstDay, Math.floor(reference / 1000));
    let seq = Math.floor(reference / 1000) === day ? (reference % 1000) + 1 : 1;
    while (out.length < 50 && day <= today) {
      const o = this.order(day * 1000 + seq);
      if (o) {
        out.push(o);
        seq++;
      } else {
        day++;
        seq = 1;
      }
    }
    return out;
  }
  async ordersUpdatedAfter(token: string, _since: Date, page: number) {
    this.ref(token);
    // Only orders a test marked as returned have changed.
    const orders = page === 1 ? [...this.returns.keys()].map((id) => this.order(Number(id.slice(4)))!).filter(Boolean) : [];
    return { orders, lastPage: 1 };
  }
  private id(kind: string, body: unknown) {
    return `${kind}-${createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 12)}`;
  }
  async createSupplier(token: string, body: { name: string; code?: string }) {
    this.created.push({ kind: 'supplier', token, body });
    return { id: this.id('sup', [this.ref(token), body]) };
  }
  async createUser(token: string, body: { name: string; pin: string; lang?: string }) {
    this.created.push({ kind: 'user', token, body });
    return { id: this.id('usr', [this.ref(token), body.name]) };
  }
  async createInventoryTransaction(token: string, body: InventoryTransactionInput) {
    this.ref(token);
    if (!body.items.length) throw new FoodicsError('The items field is required.', 422);
    this.created.push({ kind: 'inventory_transaction', token, body });
    const id = this.id('trx', [token, body]);
    return { id, reference: `PUR-${id.slice(4, 10).toUpperCase()}` };
  }
  async revoke(token: string) {
    this.ref(token);
    this.created.push({ kind: 'revoke', token, body: null });
  }
}

export function foodicsApi(config: AppConfig): FoodicsApi {
  return config.FOODICS_MODE === 'simulated' ? new SimulatedFoodics(config) : new HttpFoodics(config);
}
