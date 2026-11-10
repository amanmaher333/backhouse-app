import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { and, eq, isNull } from 'drizzle-orm';
import type { INestApplication } from '@nestjs/common';
import { memberships, organizations, roles, runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';
import { VerificationService } from '../src/verification/verification.js';
import { DbService } from '../src/common/db.service.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const PASSWORD = 'correct-horse-battery';
const uniq = () => Math.random().toString(36).slice(2, 10);
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const cr = (suffix: string) => `10${String(Math.floor(Math.random() * 1e4)).padStart(4, '1')}${suffix}`;
let app: INestApplication;
let http: ReturnType<typeof request>;
let db: DbService;
let verification: VerificationService;

async function signup(crNumber: string, name = 'Najd Kitchens Co.', nameAr = 'شركة مطابخ نجد') {
  const s = await http
    .post('/v1/auth/signup')
    .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'Sara', organization: { name: 'Najd Kitchens' }, legalEntity: { name, nameAr, crNumber, vatNumber: '310122393500003' } })
    .expect(201);
  return { token: s.body.accessToken as string, legalEntity: s.body.legalEntity, userId: s.body.user.id as string };
}

/** Kitchain staff: a member of Kitchain's own organisation (type "platform"). */
async function platformAdmin() {
  const x = await signup(cr('1234'));
  await db.system(async (tx) => {
    const [org] = await tx.insert(organizations).values({ type: 'platform', name: `Kitchain ${uniq()}` }).returning();
    const [role] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, 'org_admin')));
    await tx.insert(memberships).values({ orgId: org!.id, userId: x.userId, roleId: role!.id });
  });
  return x.token;
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB, AGENTS_LLM: 'template', REGISTRY_PROVIDER: 'simulated', NODE_ENV: 'test' }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
  db = app.get(DbService);
  verification = app.get(VerificationService);
});
afterAll(async () => {
  await app?.close();
});

describe('Company verification', () => {
  it('verifies an active CR whose name matches, at sign-up, with nobody involved', async () => {
    const x = await signup(cr('1234'));
    expect(x.legalEntity.verificationStatus).toBe('verified');
    const [le] = (await http.get('/v1/legal-entities').set(auth(x.token)).expect(200)).body;
    expect(le).toMatchObject({ verificationStatus: 'verified', registryName: 'Najd Kitchens Co.' });
    expect(le.verifiedAt).toBeTruthy();
    const history = (await http.get(`/v1/legal-entities/${le.id}/verifications`).set(auth(x.token)).expect(200)).body;
    expect(history[0]).toMatchObject({ status: 'verified', provider: 'simulated', nameScore: '1.000' });
  });

  it('rejects a CR that is not registered or has expired, with the reason', async () => {
    const missing = await signup(cr('0000'));
    expect(missing.legalEntity.verificationStatus).toBe('rejected');
    const expired = await signup(cr('9999'));
    const h = (await http.get(`/v1/legal-entities/${expired.legalEntity.id}/verifications`).set(auth(expired.token))).body;
    expect(h[0]).toMatchObject({ status: 'rejected', reason: 'The CR is expired' });
  });

  it('sends a name mismatch to Kitchain review, the only manual step', async () => {
    const x = await signup(cr('8888'));
    expect(x.legalEntity.verificationStatus).toBe('needs_review');
    const reviewer = await platformAdmin();
    await http.get('/v1/platform/verifications').set(auth(x.token)).expect(403); // customers cannot see the queue

    const queue = (await http.get('/v1/platform/verifications').set(auth(reviewer)).expect(200)).body;
    const item = queue.find((q: any) => q.v.legalEntityId === x.legalEntity.id);
    expect(item.v.reason).toContain('مؤسسة مخابز الرياض التجارية');
    await http.post(`/v1/platform/verifications/${item.v.id}/decide`).set(auth(reviewer)).send({ decision: 'approve', note: 'Trade name differs; CR owner confirmed' }).expect(200);
    await http.post(`/v1/platform/verifications/${item.v.id}/decide`).set(auth(reviewer)).send({ decision: 'deny' }).expect(400);
    const [le] = (await http.get('/v1/legal-entities').set(auth(x.token))).body;
    expect(le.verificationStatus).toBe('verified');
  });

  it('retries when the register is unreachable, and re-checks when the CR changes', async () => {
    const x = await signup(cr('7777'));
    expect(x.legalEntity.verificationStatus).toBe('pending');
    await verification.retryPending();
    expect((await http.get('/v1/legal-entities').set(auth(x.token))).body[0].verificationStatus).toBe('pending');

    const fixed = (await http.patch(`/v1/legal-entities/${x.legalEntity.id}`).set(auth(x.token)).send({ crNumber: cr('1234') }).expect(200)).body;
    expect(fixed.verificationStatus).toBe('verified');
    // A manual re-run is available too.
    expect((await http.post(`/v1/legal-entities/${x.legalEntity.id}/verify`).set(auth(x.token)).send({}).expect(200)).body.status).toBe('verified');
  });

  it('checks new legal entities added later', async () => {
    const x = await signup(cr('1234'));
    const le = (await http.post('/v1/legal-entities').set(auth(x.token)).send({ name: 'Najd Catering', crNumber: cr('0000') }).expect(201)).body;
    expect(le.verificationStatus).toBe('rejected');
    const plain = (await http.post('/v1/legal-entities').set(auth(x.token)).send({ name: 'No CR yet' }).expect(201)).body;
    expect(plain.verificationStatus).toBe('unverified');
  });
});
