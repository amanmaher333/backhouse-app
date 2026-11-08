import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { runMigrations } from '@boh/db';
import { createApp } from '../src/bootstrap.js';
import { loadConfig } from '../src/config.js';

const DB = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
let app: INestApplication;
let http: ReturnType<typeof request>;

const uniq = () => Math.random().toString(36).slice(2, 10);
const PASSWORD = 'correct-horse-battery';

async function signup(orgName = `Org ${uniq()}`, type: 'restaurant_group' | 'supplier' = 'restaurant_group') {
  const email = `${uniq()}@test.sa`;
  const res = await http
    .post('/v1/auth/signup')
    .send({
      email,
      password: PASSWORD,
      fullName: 'Owner',
      organization: { name: orgName, nameAr: 'مؤسسة', type },
      legalEntity: { name: `${orgName} LLC`, vatNumber: '310122393500003', crNumber: '1010123456' },
    })
    .expect(201);
  return { email, token: res.body.accessToken as string, refresh: res.body.refreshToken as string, orgId: res.body.organization.id as string, legalEntityId: res.body.legalEntity.id as string };
}

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function inviteAndAccept(ownerToken: string, roleKey: string, siteIds?: string[]) {
  const roles = await http.get('/v1/roles').set(auth(ownerToken)).expect(200);
  const role = roles.body.find((r: any) => r.key === roleKey);
  const email = `${uniq()}@test.sa`;
  const inv = await http.post('/v1/invitations').set(auth(ownerToken)).send({ email, roleId: role.id, siteIds }).expect(201);
  const acc = await http.post('/v1/auth/accept-invitation').send({ token: inv.body.token, password: PASSWORD, fullName: roleKey }).expect(201);
  return { email, token: acc.body.accessToken as string };
}

beforeAll(async () => {
  await runMigrations(DB);
  app = await createApp(loadConfig({ DATABASE_URL: DB }), { logger: false });
  await app.init();
  http = request(app.getHttpServer());
});

afterAll(async () => {
  await app?.close();
});

describe('auth', () => {
  it('signs up, logs in, refreshes with rotation and detects reuse', async () => {
    const owner = await signup();
    const login = await http.post('/v1/auth/login').send({ email: owner.email, password: PASSWORD }).expect(200);
    expect(login.body.orgId).toBe(owner.orgId); // single org auto-selected
    expect(login.body.user.passwordHash).toBeUndefined();

    const r1 = await http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(200);
    expect(r1.body.orgId).toBe(owner.orgId); // single org auto-selected on refresh too
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    // Reusing the old token revokes the family, including the new one.
    await http.post('/v1/auth/refresh').send({ refreshToken: login.body.refreshToken }).expect(401);
    await http.post('/v1/auth/refresh').send({ refreshToken: r1.body.refreshToken }).expect(401);
  });

  it('rejects bad credentials, duplicate emails and invalid KSA identifiers', async () => {
    const owner = await signup();
    await http.post('/v1/auth/login').send({ email: owner.email, password: 'wrong-password!' }).expect(401);
    await http
      .post('/v1/auth/signup')
      .send({ email: owner.email, password: PASSWORD, fullName: 'X', organization: { name: 'Dup' } })
      .expect(409);
    const bad = await http
      .post('/v1/auth/signup')
      .send({ email: `${uniq()}@t.sa`, password: PASSWORD, fullName: 'X', organization: { name: 'X' }, legalEntity: { name: 'X', vatNumber: '123' } })
      .expect(400);
    expect(JSON.stringify(bad.body.issues)).toContain('VAT');
  });

  it('requires a token, and returns /me with memberships', async () => {
    await http.get('/v1/sites').expect(401);
    const owner = await signup();
    const me = await http.get('/v1/auth/me').set(auth(owner.token)).expect(200);
    expect(me.body.currentOrgId).toBe(owner.orgId);
    expect(me.body.memberships[0].roleKey).toBe('org_admin');
  });
});

describe('org structure', () => {
  it('creates sites and locations, and records audit events', async () => {
    const owner = await signup();
    const site = await http
      .post('/v1/sites')
      .set(auth(owner.token))
      .send({ legalEntityId: owner.legalEntityId, name: 'Olaya Branch', nameAr: 'فرع العليا', code: 'OLY', address: { city: 'Riyadh' } })
      .expect(201);
    expect(site.body.timezone).toBe('Asia/Riyadh');
    const loc = await http.post(`/v1/sites/${site.body.id}/locations`).set(auth(owner.token)).send({ name: 'Walk-in chiller' }).expect(201);
    await http.patch(`/v1/sites/${site.body.id}/locations/${loc.body.id}`).set(auth(owner.token)).send({ sortOrder: 2 }).expect(200);
    // Duplicate site code → 409
    await http.post('/v1/sites').set(auth(owner.token)).send({ legalEntityId: owner.legalEntityId, name: 'Dup', code: 'OLY' }).expect(409);

    const events = await http.get('/v1/audit-events').set(auth(owner.token)).query({ entityType: 'storage_location' }).expect(200);
    expect(events.body.map((e: any) => e.action)).toEqual(['storage_location.updated', 'storage_location.created']);
    expect(events.body[0].before.sortOrder).toBe(0);
    expect(events.body[0].after.sortOrder).toBe(2);
  });

  it('isolates tenants: another org cannot see or touch my sites', async () => {
    const a = await signup('Tenant A');
    const b = await signup('Tenant B', 'supplier');
    const site = await http.post('/v1/sites').set(auth(a.token)).send({ legalEntityId: a.legalEntityId, name: 'A site' }).expect(201);

    const bSites = await http.get('/v1/sites').set(auth(b.token)).expect(200);
    expect(bSites.body).toEqual([]);
    await http.get(`/v1/sites/${site.body.id}`).set(auth(b.token)).expect(404);
    await http.patch(`/v1/sites/${site.body.id}`).set(auth(b.token)).send({ name: 'pwned' }).expect(404);
    // B cannot attach a site to A's legal entity.
    await http.post('/v1/sites').set(auth(b.token)).send({ legalEntityId: a.legalEntityId, name: 'x' }).expect(422);
    // B cannot switch into A.
    await http.post('/v1/auth/switch-org').set(auth(b.token)).send({ orgId: a.orgId }).expect(403);
  });
});

describe('permissions', () => {
  it('limits site-scoped staff to their sites and blocks management', async () => {
    const owner = await signup();
    const s1 = await http.post('/v1/sites').set(auth(owner.token)).send({ legalEntityId: owner.legalEntityId, name: 'S1' }).expect(201);
    const s2 = await http.post('/v1/sites').set(auth(owner.token)).send({ legalEntityId: owner.legalEntityId, name: 'S2' }).expect(201);
    const mgr = await inviteAndAccept(owner.token, 'site_manager', [s1.body.id]);

    const visible = await http.get('/v1/sites').set(auth(mgr.token)).expect(200);
    expect(visible.body.map((s: any) => s.id)).toEqual([s1.body.id]);
    await http.get(`/v1/sites/${s2.body.id}`).set(auth(mgr.token)).expect(403);
    await http.post(`/v1/sites/${s1.body.id}/locations`).set(auth(mgr.token)).send({ name: 'Dry store' }).expect(201);
    await http.post(`/v1/sites/${s2.body.id}/locations`).set(auth(mgr.token)).send({ name: 'Nope' }).expect(403);
    await http.post('/v1/sites').set(auth(mgr.token)).send({ legalEntityId: owner.legalEntityId, name: 'S3' }).expect(403);
    await http.get('/v1/members').set(auth(mgr.token)).expect(403);
  });

  it('prevents privilege escalation and removing the last admin', async () => {
    const owner = await signup();
    const ops = await inviteAndAccept(owner.token, 'ops_manager');
    const roles = await http.get('/v1/roles').set(auth(ops.token)).expect(200);
    const admin = roles.body.find((r: any) => r.key === 'org_admin');
    // Ops manager can manage members but cannot hand out org_admin.
    await http.post('/v1/invitations').set(auth(ops.token)).send({ email: `${uniq()}@t.sa`, roleId: admin.id }).expect(403);
    // Nor create a role with permissions they lack.
    await http
      .post('/v1/roles')
      .set(auth(ops.token))
      .send({ key: 'sneaky', name: 'Sneaky', scope: 'org', permissions: ['org:manage'] })
      .expect(403);

    const members = await http.get('/v1/members').set(auth(owner.token)).expect(200);
    const ownerMembership = members.body.find((m: any) => m.roleKey === 'org_admin');
    await http.delete(`/v1/members/${ownerMembership.membershipId}`).set(auth(owner.token)).expect(400);
  });

  it('supports custom roles', async () => {
    const owner = await signup();
    const role = await http
      .post('/v1/roles')
      .set(auth(owner.token))
      .send({ key: 'auditor', name: 'Auditor', nameAr: 'مدقق', scope: 'org', permissions: ['audit:read', 'site:read'] })
      .expect(201);
    await http
      .post('/v1/roles')
      .set(auth(owner.token))
      .send({ key: 'bad', name: 'Bad', scope: 'org', permissions: ['launch:missiles'] })
      .expect(400);
    const u = await inviteAndAccept(owner.token, 'auditor');
    await http.get('/v1/audit-events').set(auth(u.token)).expect(200);
    await http.get('/v1/members').set(auth(u.token)).expect(403);
    // System roles are read-only.
    const roles = await http.get('/v1/roles').set(auth(owner.token)).expect(200);
    const staff = roles.body.find((r: any) => r.key === 'staff');
    await http.patch(`/v1/roles/${staff.id}`).set(auth(owner.token)).send({ name: 'x' }).expect(404);
    expect(role.body.isSystem).toBe(false);
  });
});
