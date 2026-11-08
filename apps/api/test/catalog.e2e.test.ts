import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;

async function signup(name = `Org ${uniq()}`) {
  const res = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name } })
    .expect(201);
  return { token: res.body.accessToken as string, orgId: res.body.organization.id as string, legalEntityId: res.body.legalEntity.id as string };
}

async function invite(ownerToken: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(ownerToken)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const inv = await http.post('/v1/invitations').set(auth(ownerToken)).send({ email: `${uniq()}@t.sa`, roleId: role.id, siteIds }).expect(201);
  const acc = await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201);
  return acc.body.accessToken as string;
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB }), { logger: process.env.API_LOG === '1' });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('items and the shared ingredient map', () => {
  it('auto-matches messy supplier-style names in English and Arabic', async () => {
    const o = await signup();
    const tomato = await http.post('/v1/items').set(auth(o.token)).send({ name: 'Tomato Rnd 1KG Jordan' }).expect(201);
    expect(tomato.body.match.auto.slug).toBe('tomato');
    expect(tomato.body.canonicalSource).toBe('auto');
    expect(tomato.body.baseUnit).toBe('g');
    expect(tomato.body.category).toBe('produce');
    expect(tomato.body.code).toBe('ITM-00001');
    expect(tomato.body.packs[0].baseQty).toBe('1000.000000');

    const chicken = await http.post('/v1/items').set(auth(o.token)).send({ name: 'صدر دجاج مجمد' }).expect(201);
    expect(chicken.body.match.auto.slug).toBe('chicken-breast');
    expect(chicken.body.code).toBe('ITM-00002');

    const eggs = await http.post('/v1/items').set(auth(o.token)).send({ name: 'Eggs Large 30pcs' }).expect(201);
    expect(eggs.body.baseUnit).toBe('each');
    expect(eggs.body.allergens).toEqual(['eggs']);
    expect(eggs.body.conversions[0].to).toEqual({ qty: '60.00', unit: 'g' }); // piece weight from the shared map
  });

  it('requires a base unit when nothing matches, and blocks duplicate names', async () => {
    const o = await signup();
    await http.post('/v1/items').set(auth(o.token)).send({ name: 'Zzqx house blend' }).expect(400);
    const item = await http.post('/v1/items').set(auth(o.token)).send({ name: 'Zzqx house blend', baseUnit: 'g', category: 'spices' }).expect(201);
    expect(item.body.canonicalId).toBeNull();
    await http.post('/v1/items').set(auth(o.token)).send({ name: 'zzqx HOUSE blend', baseUnit: 'g' }).expect(409);
    const dups = await http.get('/v1/items/duplicates').query({ name: 'Zzqx house blend 1kg' }).set(auth(o.token)).expect(200);
    expect(dups.body[0].id).toBe(item.body.id);
  });

  it('resolves nested packs and protects packs in use', async () => {
    const o = await signup();
    const oil = await http.post('/v1/items').set(auth(o.token)).send({ name: 'Olive Oil Extra Virgin', defaultPack: false }).expect(201);
    expect(oil.body.baseUnit).toBe('ml');
    const bottle = await http.post(`/v1/items/${oil.body.id}/packs`).set(auth(o.token)).send({ name: 'Bottle 1L', qty: 1, unit: 'l' }).expect(201);
    const kase = await http.post(`/v1/items/${oil.body.id}/packs`).set(auth(o.token)).send({ name: 'Case 6×1L', qty: 6, parentPackId: bottle.body.id }).expect(201);
    expect(kase.body.baseQty).toBe('6000.000000');
    // Changing the bottle size updates the case too.
    await http.patch(`/v1/items/${oil.body.id}/packs/${bottle.body.id}`).set(auth(o.token)).send({ qty: 0.75 }).expect(200);
    const detail = await http.get(`/v1/items/${oil.body.id}`).set(auth(o.token)).expect(200);
    expect(detail.body.packs.find((p: any) => p.id === kase.body.id).baseQty).toBe('4500.000000');
    // A pack can't point at itself through its children.
    await http.patch(`/v1/items/${oil.body.id}/packs/${bottle.body.id}`).set(auth(o.token)).send({ parentPackId: kase.body.id }).expect(422);
    await http.delete(`/v1/items/${oil.body.id}/packs/${bottle.body.id}`).set(auth(o.token)).expect(400);
    // Cross-dimension pack: 1 kg of oil via density 0.91 g/ml.
    const kg = await http.post(`/v1/items/${oil.body.id}/packs`).set(auth(o.token)).send({ name: 'Tin 1kg', qty: 1, unit: 'kg' }).expect(201);
    expect(Number(kg.body.baseQty)).toBeCloseTo(1098.9, 1);
  });

  it('learns a new alias only after two organisations confirm it', async () => {
    const name = `Bandoora ${uniq()}`;
    const a = await signup();
    const b = await signup();
    const canon = await http.get('/v1/canonical-ingredients').query({ q: 'tomato' }).set(auth(a.token)).expect(200);
    const tomatoId = canon.body.find((c: any) => c.slug === 'tomato').canonicalId;

    const before = await http.post('/v1/catalog/match').set(auth(a.token)).send({ names: [name] }).expect(200);
    expect(before.body[0].auto).toBeNull();

    const itemA = await http.post('/v1/items').set(auth(a.token)).send({ name, baseUnit: 'g', canonicalId: null }).expect(201);
    await http.put(`/v1/items/${itemA.body.id}/canonical`).set(auth(a.token)).send({ canonicalId: tomatoId }).expect(200);
    const afterOne = await http.post('/v1/catalog/match').set(auth(b.token)).send({ names: [name] }).expect(200);
    expect(afterOne.body[0].auto).toBeNull(); // one org is not enough

    await http.post('/v1/items').set(auth(b.token)).send({ name, baseUnit: 'g', canonicalId: tomatoId }).expect(201);
    const afterTwo = await http.post('/v1/catalog/match').set(auth(a.token)).send({ names: [name] }).expect(200);
    expect(afterTwo.body[0].auto?.slug).toBe('tomato');
  });

  it('isolates items between organisations', async () => {
    const a = await signup();
    const b = await signup();
    const item = await http.post('/v1/items').set(auth(a.token)).send({ name: 'Cucumber' }).expect(201);
    await http.get(`/v1/items/${item.body.id}`).set(auth(b.token)).expect(404);
    const list = await http.get('/v1/items').set(auth(b.token)).expect(200);
    expect(list.body).toEqual([]);
  });
});

describe('suppliers and prices', () => {
  it('shares supplier profiles by VAT number without sharing relationships', async () => {
    const a = await signup();
    const b = await signup();
    const vat = `3${String(Date.now()).slice(-13)}3`;
    const sa = await http
      .post('/v1/suppliers')
      .set(auth(a.token))
      .send({ displayName: 'Al Watania Foods', vatNumber: vat, orderChannel: 'whatsapp', contactPhone: '+966500000001' })
      .expect(201);
    await http.post('/v1/suppliers').set(auth(a.token)).send({ displayName: 'Again', vatNumber: vat, contactEmail: 'x@y.sa' }).expect(409);
    const sb = await http.post('/v1/suppliers').set(auth(b.token)).send({ displayName: 'Watania (our name)', vatNumber: vat, contactEmail: 'orders@w.sa' }).expect(201);
    expect(sb.body.supplierProfileId).toBe(sa.body.supplierProfileId);
    await http.get(`/v1/suppliers/${sa.body.id}`).set(auth(b.token)).expect(404);
    await http.post('/v1/suppliers').set(auth(a.token)).send({ displayName: 'Bad VAT', vatNumber: '123', contactEmail: 'x@y.sa' }).expect(400);
    await http.post('/v1/suppliers').set(auth(a.token)).send({ displayName: 'No email', orderChannel: 'email' }).expect(400);
  });

  it('tracks prices, history and recent changes; hides prices from staff', async () => {
    const o = await signup();
    const site = await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'Olaya' }).expect(201);
    const salmon = await http.post('/v1/items').set(auth(o.token)).send({ name: 'Salmon Fillet Norwegian' }).expect(201);
    const pack = salmon.body.packs[0];
    const sup = await http.post('/v1/suppliers').set(auth(o.token)).send({ displayName: 'Gulf Seafood', contactEmail: 'o@gs.sa' }).expect(201);
    const line = await http
      .post(`/v1/suppliers/${sup.body.id}/items`)
      .set(auth(o.token))
      .send({ itemId: salmon.body.id, packId: pack.id, supplierSku: 'SAL-1', supplierName: 'Salmon Fillet Fresh 1kg', price: 95, isPreferred: true })
      .expect(201);
    // Counts in list views come from correlated subqueries; check they bind to the right rows.
    const listed = await http.get('/v1/items').set(auth(o.token)).expect(200);
    expect(listed.body[0]).toMatchObject({ packCount: 1, supplierCount: 1 });
    expect(Number(listed.body[0].bestCostPerBase)).toBeCloseTo(0.095, 6);
    const sups = await http.get('/v1/suppliers').set(auth(o.token)).expect(200);
    expect(sups.body[0].itemCount).toBe(1);
    const p = await http.post(`/v1/supplier-items/${line.body.id}/prices`).set(auth(o.token)).send({ price: 108.3 }).expect(201);
    expect(p.body.changed).toBe(true);
    const same = await http.post(`/v1/supplier-items/${line.body.id}/prices`).set(auth(o.token)).send({ price: 108.3 }).expect(201);
    expect(same.body.changed).toBe(false);

    const history = await http.get(`/v1/supplier-items/${line.body.id}/prices`).set(auth(o.token)).expect(200);
    expect(history.body.map((h: any) => h.price)).toEqual(['108.3000', '95.0000']);
    const changes = await http.get('/v1/price-changes').set(auth(o.token)).expect(200);
    expect(changes.body[0].changePct).toBeCloseTo(14, 1);
    const detail = await http.get(`/v1/items/${salmon.body.id}`).set(auth(o.token)).expect(200);
    expect(detail.body.supplierItems[0].costPerBase).toBe('0.1083');

    const staff = await invite(o.token, 'staff', [site.body.id]);
    const staffView = await http.get(`/v1/items/${salmon.body.id}`).set(auth(staff)).expect(200);
    expect(staffView.body.supplierItems[0].currentPrice).toBeUndefined();
    await http.get('/v1/price-changes').set(auth(staff)).expect(403);
    await http.post('/v1/items').set(auth(staff)).send({ name: 'Nope', baseUnit: 'g' }).expect(403);
  });

  it('sets par levels per site in packs, limited to the manager’s sites', async () => {
    const o = await signup();
    const s1 = await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'S1' }).expect(201);
    const s2 = await http.post('/v1/sites').set(auth(o.token)).send({ legalEntityId: o.legalEntityId, name: 'S2' }).expect(201);
    const oil = await http.post('/v1/items').set(auth(o.token)).send({ name: 'Vegetable oil' }).expect(201); // default pack: 1 L
    const mgr = await invite(o.token, 'site_manager', [s1.body.id]);
    const res = await http
      .put(`/v1/items/${oil.body.id}/sites/${s1.body.id}`)
      .set(auth(mgr))
      .send({ parLevel: 20, reorderPoint: 8, packId: oil.body.packs[0].id })
      .expect(200);
    expect(res.body.parLevel).toBe('20000.000000');
    await http.put(`/v1/items/${oil.body.id}/sites/${s2.body.id}`).set(auth(mgr)).send({ parLevel: 1 }).expect(403);
  });

  it('imports items and a price list from CSV (dry run, then commit)', async () => {
    const o = await signup();
    const itemsCsv = '﻿name,name_ar,category,base_unit\nTomato Rnd 1KG,طماطم,,\nOnion Red India,,,\nHouse spice mix,,spices,g\nBroken row,,nosuchcategory,\n';
    const dry = await http.post('/v1/items/import').set(auth(o.token)).send({ csv: itemsCsv, dryRun: true }).expect(200);
    expect(dry.body.summary).toEqual({ create: 3, update: 0, skip: 0, error: 1 });
    expect(dry.body.results[0].match.slug).toBe('tomato');
    // Committing with an error writes nothing.
    await http.post('/v1/items/import').set(auth(o.token)).send({ csv: itemsCsv, dryRun: false }).expect(400);
    expect((await http.get('/v1/items').set(auth(o.token))).body).toEqual([]);

    const ok = itemsCsv.split('\n').slice(0, 4).join('\n');
    const done = await http.post('/v1/items/import').set(auth(o.token)).send({ csv: ok, dryRun: false }).expect(200);
    expect(done.body.summary.create).toBe(3);
    const again = await http.post('/v1/items/import').set(auth(o.token)).send({ csv: ok, dryRun: true }).expect(200);
    expect(again.body.summary.skip).toBe(3);

    const sup = await http.post('/v1/suppliers').set(auth(o.token)).send({ displayName: 'Fresh Farms', contactEmail: 'a@ff.sa' }).expect(201);
    const prices = 'supplier_sku,supplier_name,item_name,pack,price\nT-1,Tomato 1kg,Tomato Rnd 1KG,,4.50\nO-1,Red onion 1kg,Onion Red India,1 kg,3.25\n';
    const p1 = await http.post(`/v1/suppliers/${sup.body.id}/prices/import`).set(auth(o.token)).send({ csv: prices, dryRun: false }).expect(200);
    expect(p1.body.summary.create).toBe(2);
    const p2 = await http
      .post(`/v1/suppliers/${sup.body.id}/prices/import`)
      .set(auth(o.token))
      .send({ csv: prices.replace('4.50', '5.40'), dryRun: false })
      .expect(200);
    expect(p2.body.summary).toEqual({ create: 0, price: 1, skip: 1, error: 0 });
    expect(p2.body.results[0].changePct).toBeCloseTo(20, 5);
    const exported = await http.get(`/v1/suppliers/${sup.body.id}/prices/export`).set(auth(o.token)).expect(200);
    expect(exported.headers['content-type']).toContain('text/csv');
    expect(exported.text).toContain('T-1,Tomato 1kg');
  });
});
