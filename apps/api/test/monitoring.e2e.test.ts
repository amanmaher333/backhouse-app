import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { NotFoundException, type ArgumentsHost, type INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { ErrorFilter } from '../src/common/errors.js';
import { initMonitoring, monitoringEnabled, scrubEvent, stopMonitoring } from '../src/common/monitoring.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
let app: INestApplication;
let http: ReturnType<typeof request>;

/** Events Sentry would have sent, captured by a fake transport. */
const sent: any[] = [];
const transport = () => ({
  send: async (envelope: any) => {
    for (const [header, payload] of envelope[1]) if (header.type === 'event') sent.push(payload);
    return {};
  },
  flush: async () => true,
});
const flushed = async () => {
  await new Promise((r) => setTimeout(r, 50));
  return sent;
};

/** A minimal Express-like host for calling the filter directly. */
function host(req: Record<string, unknown>) {
  const res: any = { statusCode: 0, body: undefined };
  res.status = (s: number) => ((res.statusCode = s), res);
  res.json = (b: unknown) => ((res.body = b), res);
  const h = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }) } as unknown as ArgumentsHost;
  return { h, res };
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});
afterAll(async () => {
  await stopMonitoring();
  await app?.close();
});

describe('Error reporting', () => {
  it('is off without SENTRY_DSN, and the browser endpoint still answers', async () => {
    expect(monitoringEnabled()).toBe(false);
    expect(initMonitoring({ NODE_ENV: 'test' }, 'api')).toBe(false);
    await http.post('/v1/client-errors').send({ message: 'x is undefined', path: '/inbox' }).expect(204);
    await http.post('/v1/client-errors').send({ message: '' }).expect(400);
    await http.post('/v1/client-errors').send({ message: 'm'.repeat(1001) }).expect(400);
    expect(await flushed()).toHaveLength(0);
  });

  it('strips request details and personal data from events', () => {
    const e = scrubEvent({
      request: { method: 'POST', url: 'https://api/v1/auth/login?token=abc', headers: { authorization: 'Bearer x' }, cookies: { a: 'b' }, data: { password: 'p' } },
      user: { id: 'u1', email: 'a@b.sa', ip_address: '1.2.3.4' },
      breadcrumbs: [{ message: 'GET https://api.foodics.com/v5/orders?access_token=x' }],
    } as any);
    expect(e.request).toEqual({ method: 'POST', url: 'https://api/v1/auth/login' });
    expect(e.user).toEqual({ id: 'u1' });
    expect(e.breadcrumbs).toBeUndefined();
  });

  it('reports unexpected API errors and browser errors once a DSN is set', async () => {
    expect(initMonitoring({ NODE_ENV: 'test', SENTRY_DSN: 'https://public@sentry.example/1', SENTRY_RELEASE: 'abc123' }, 'api', { transport })).toBe(true);
    const filter = new ErrorFilter();

    // Mapped errors are answers, not faults: nothing is sent.
    const nf = host({ method: 'GET', path: '/v1/items/1' });
    filter.catch(new NotFoundException('Item not found'), nf.h);
    expect(nf.res.statusCode).toBe(404);
    expect(await flushed()).toHaveLength(0);

    // An unknown error: a 500 to the caller, an event to Sentry with ids and the route pattern only.
    const boom = host({
      method: 'POST',
      baseUrl: '',
      route: { path: '/v1/purchase-orders/:id/send' },
      path: '/v1/purchase-orders/7f3/send',
      requestId: 'req-1',
      auth: { userId: 'user-1', orgId: 'org-1' },
      headers: { authorization: 'Bearer secret' },
      body: { note: 'call Ahmed on 0500000000' },
    });
    filter.catch(new TypeError("Cannot read properties of undefined (reading 'lines')"), boom.h);
    expect(boom.res.statusCode).toBe(500);
    expect(boom.res.body).toEqual({ statusCode: 500, error: 'InternalServerError', message: 'Unexpected error' });
    const [event] = await flushed();
    expect(event.exception.values[0]).toMatchObject({ type: 'TypeError', value: "Cannot read properties of undefined (reading 'lines')" });
    expect(event.tags).toMatchObject({ service: 'api', source: 'http', method: 'POST', route: '/v1/purchase-orders/:id/send', request_id: 'req-1', org_id: 'org-1' });
    expect(event.user).toEqual({ id: 'user-1' });
    expect(event.release).toBe('abc123');
    expect(event.environment).toBe('test');
    expect(JSON.stringify(event)).not.toContain('Bearer secret');
    expect(JSON.stringify(event)).not.toContain('0500000000');
    sent.length = 0;

    // A browser error from a signed-in person: ids from their token, page without its query string.
    const o = await http.post('/v1/auth/signup').send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Owner', organization: { name: `Org ${uniq()}` } }).expect(201);
    await http
      .post('/v1/client-errors')
      .set({ Authorization: `Bearer ${o.body.accessToken}` })
      .send({ message: 'r.totals is null', stack: 'TypeError: r.totals is null\n    at FoodCost (page.js:1:2)', path: '/food-cost?siteId=abc', kind: 'render', userAgent: 'Mozilla/5.0' })
      .expect(204);
    const [web] = await flushed();
    expect(web.exception.values[0]).toMatchObject({ type: 'BrowserError', value: 'r.totals is null' });
    expect(web.tags).toMatchObject({ source: 'web', kind: 'render', page: '/food-cost', org_id: o.body.organization.id });
    expect(web.user).toEqual({ id: o.body.user.id });
    expect(JSON.stringify(web)).not.toContain(o.body.user.email);
    sent.length = 0;

    // A page stuck in an error loop is cut off rather than flooding Sentry.
    const codes: number[] = [];
    for (let i = 0; i < 25; i++) codes.push((await http.post('/v1/client-errors').send({ message: `loop ${i}` })).status);
    expect(codes.filter((c) => c === 429).length).toBeGreaterThan(0);
    expect((await flushed()).length).toBeLessThanOrEqual(20);
  });
});
