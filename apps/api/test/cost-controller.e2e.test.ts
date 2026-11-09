import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { lastCompletedWeek } from '../src/agents/cost-controller.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
let app: INestApplication;
let http: ReturnType<typeof request>;

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', FOODICS_MODE: 'simulated' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await app?.close();
});

describe('Cost Controller', () => {
  it('picks the last completed week in the site’s time zone', () => {
    // Tuesday 10 Nov 2026, 01:00 in Riyadh (Monday 22:00 UTC): last week ended Saturday 7 Nov.
    expect(lastCompletedWeek(new Date('2026-11-09T22:00:00Z'), 'Asia/Riyadh', 6)).toEqual({ from: '2026-11-01', to: '2026-11-07' });
    // Saturday itself isn't complete yet: the week before.
    expect(lastCompletedWeek(new Date('2026-11-07T12:00:00Z'), 'Asia/Riyadh', 6)).toEqual({ from: '2026-10-25', to: '2026-10-31' });
    // Weeks ending Thursday.
    expect(lastCompletedWeek(new Date('2026-11-09T12:00:00Z'), 'Asia/Riyadh', 4)).toEqual({ from: '2026-10-30', to: '2026-11-05' });
  });

  it('reports last week’s food cost per site and can start a count', async () => {
    const o = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
    const token = o.body.accessToken as string;
    const site = (await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Olaya', nameAr: 'العليا', timezone: 'Asia/Riyadh' }).expect(201)).body;
    const sup = (await http.post('/v1/suppliers').set(auth(token)).send({ displayName: 'Al Watania', contactEmail: 'o@w.sa' }).expect(201)).body;
    for (const [name, baseUnit, pack, price] of [
      ['Chicken breast', 'g', { name: 'Carton 10 kg', qty: 10, unit: 'kg' }, 250],
      ['Burger bun', 'each', { name: 'Bag of 10', qty: 10, unit: 'each' }, 8],
      ['Tomato', 'g', { name: 'Carton 6 kg', qty: 6, unit: 'kg' }, 33],
    ] as const) {
      const it = (await http.post('/v1/items').set(auth(token)).send({ name, baseUnit, defaultPack: false }).expect(201)).body;
      const p = (await http.post(`/v1/items/${it.id}/packs`).set(auth(token)).send(pack).expect(201)).body;
      await http.post(`/v1/suppliers/${sup.id}/items`).set(auth(token)).send({ itemId: it.id, packId: p.id, price }).expect(201);
    }
    // Foodics demo sales at Olaya; only the burger gets a recipe, so the salad is sold without one.
    const { url } = (await http.post('/v1/integrations/foodics/connect').set(auth(token)).expect(200)).body;
    const u = new URL(url);
    await http.post('/v1/integrations/foodics/callback').set(auth(token)).send({ code: u.searchParams.get('code'), state: u.searchParams.get('state') }).expect(200);
    await http.post('/v1/integrations/foodics/sync').set(auth(token)).expect(200);
    const burger = (await http.get('/v1/recipes/pos-products').set(auth(token)).expect(200)).body.find((p: any) => p.name === 'Chicken Burger');
    await http.post('/v1/recipes/from-pos').set(auth(token)).send({ productIds: [burger.id] }).expect(200);
    const burgerRecipe = (await http.get('/v1/recipes').set(auth(token)).expect(200)).body[0];
    await http.patch(`/v1/recipes/${burgerRecipe.id}`).set(auth(token)).send({ targetCostPct: 15 }).expect(200);

    // Hiring the agent runs its first scan straight away.
    const catalogue = (await http.get('/v1/agents').set(auth(token)).expect(200)).body;
    expect(catalogue.available.map((c: any) => c.kind)).toContain('cost_controller');
    const agent = (await http.post('/v1/agents').set(auth(token)).send({ kind: 'cost_controller' }).expect(201)).body;
    const tasks = (await http.get('/v1/agent-tasks').set(auth(token)).expect(200)).body.filter((t: any) => t.kind === 'weekly_food_cost');
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    const week = lastCompletedWeek(new Date(), 'Asia/Riyadh', 6);
    expect(task.subjectKey).toBe(`weekly:${site.id}:${week.to}`);
    expect(task.evidence.period).toEqual(week);

    // The figures are the food cost report's for that week.
    const report = (await http.get(`/v1/food-cost?siteId=${site.id}&from=${week.from}&to=${week.to}`).set(auth(token)).expect(200)).body;
    expect(task.evidence.totals).toEqual(report.totals);
    expect(task.evidence.withoutRecipe).toMatchObject({ count: 1, products: [expect.objectContaining({ name: 'Chicken Salad' })] });
    expect(task.evidence.overTarget).toEqual([expect.objectContaining({ name: 'Chicken Burger', target: '15' })]);
    expect(task.evidence.gaps).toMatchObject({ countAtStart: false, countAtEnd: false, unlinkedBranches: 2 });
    // Salad sales are well over 20% of sales without a recipe: high priority.
    expect(task.priority).toBe(1);
    expect(task.writtenBy).toBe('template');
    // No stock counts around the week: actual can't be worked out, and the headline says so.
    expect(task.evidence.actualReliable).toBe(false);
    expect(task.title).toContain("Food cost last week at Olaya");
    expect(task.title).toContain("stock wasn't counted");
    expect(task.summary).not.toContain('Biggest losses');
    expect(task.summary).toContain('Chicken Salad was sold without a recipe');
    expect(task.summaryAr).toContain('بدون وصفة');

    // Running again refreshes the same report instead of adding another.
    await http.post(`/v1/agents/${agent.agent.id}/run`).set(auth(token)).send({ scan: true }).expect(200);
    expect((await http.get('/v1/agent-tasks').set(auth(token)).expect(200)).body.filter((t: any) => t.kind === 'weekly_food_cost')).toHaveLength(1);

    // No count at the end of the week: the report offers to start one.
    expect(task.actions.map((a: any) => a.type)).toEqual(['start_count']);
    const done = (await http.post(`/v1/agent-tasks/${task.id}/approve`).set(auth(token)).send({ actionId: 'start_count' }).expect(200)).body;
    expect(done.status).toBe('executed');
    const counts = (await http.get(`/v1/stock-counts?siteId=${site.id}`).set(auth(token)).expect(200)).body;
    expect(counts).toEqual([expect.objectContaining({ status: 'open', source: 'agent', note: 'Started from the Cost Controller weekly report' })]);
  });

  it('says there are no recipes yet instead of reporting a food cost', async () => {
    const o = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
    const token = o.body.accessToken as string;
    await http.post('/v1/sites').set(auth(token)).send({ legalEntityId: o.body.legalEntity.id, name: 'Olaya', timezone: 'Asia/Riyadh' }).expect(201);
    const { url } = (await http.post('/v1/integrations/foodics/connect').set(auth(token)).expect(200)).body;
    const u = new URL(url);
    await http.post('/v1/integrations/foodics/callback').set(auth(token)).send({ code: u.searchParams.get('code'), state: u.searchParams.get('state') }).expect(200);
    await http.post('/v1/integrations/foodics/sync').set(auth(token)).expect(200);
    await http.post('/v1/agents').set(auth(token)).send({ kind: 'cost_controller' }).expect(201);
    const task = (await http.get('/v1/agent-tasks').set(auth(token)).expect(200)).body.find((t: any) => t.kind === 'weekly_food_cost');
    expect(task.evidence.hasRecipes).toBe(false);
    expect(task.title).toBe('Food cost last week at Olaya: no recipes yet');
    expect(task.titleAr).toContain('لا توجد وصفات بعد');
    expect(task.title).not.toMatch(/\d+(\.\d+)?%/);
    // Best sellers to start with (the demo burger outsells the rest).
    expect(task.summary).toContain('Start with the best sellers: Chicken Burger');
    expect(task.summary).not.toMatch(/\d+(\.\d+)?%/);
    expect(task.priority).toBe(1);
  });
});
