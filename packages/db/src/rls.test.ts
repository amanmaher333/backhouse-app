import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { config } from 'dotenv';
import { createDb, runMigrations, withTenant, withUser } from './index.js';
import { auditEvents, legalEntities, memberships, organizations, roles, sites, users } from './schema.js';

config({ path: new URL('../../../.env', import.meta.url) });
const url = process.env.TEST_DATABASE_URL ?? 'postgres://boh:boh@localhost:5432/boh_test';
const { db, pool } = createDb(url);

let orgA: string, orgB: string, userA: string, userB: string, leA: string, leB: string;

beforeAll(async () => {
  await runMigrations(url);
  const tag = Math.random().toString(36).slice(2, 8);
  const [a] = await db.insert(organizations).values({ type: 'restaurant_group', name: `A-${tag}` }).returning();
  const [b] = await db.insert(organizations).values({ type: 'supplier', name: `B-${tag}` }).returning();
  orgA = a!.id;
  orgB = b!.id;
  const [ua] = await db.insert(users).values({ email: `a-${tag}@x.test`, fullName: 'A' }).returning();
  const [ub] = await db.insert(users).values({ email: `b-${tag}@x.test`, fullName: 'B' }).returning();
  userA = ua!.id;
  userB = ub!.id;
  const [admin] = await db.select().from(roles).where(eq(roles.key, 'org_admin'));
  await db.insert(memberships).values([
    { orgId: orgA, userId: userA, roleId: admin!.id },
    { orgId: orgB, userId: userB, roleId: admin!.id },
  ]);
  const [la] = await db.insert(legalEntities).values({ orgId: orgA, name: 'LE A' }).returning();
  const [lb] = await db.insert(legalEntities).values({ orgId: orgB, name: 'LE B' }).returning();
  leA = la!.id;
  leB = lb!.id;
  await db.insert(sites).values([
    { orgId: orgA, legalEntityId: leA, name: 'Site A' },
    { orgId: orgB, legalEntityId: leB, name: 'Site B' },
  ]);
});

afterAll(async () => {
  await pool.end();
});

describe('row-level security', () => {
  it('only shows the current org rows', async () => {
    const rows = await withTenant(db, { orgId: orgA, userId: userA }, (tx) => tx.select().from(sites));
    expect(rows.map((r) => r.orgId)).toEqual([orgA]);
  });

  it('blocks inserting rows for another org', async () => {
    await expect(
      withTenant(db, { orgId: orgA, userId: userA }, (tx) => tx.insert(legalEntities).values({ orgId: orgB, name: 'evil' })),
    ).rejects.toThrow(/row-level security/);
  });

  it('blocks referencing another org parent via composite FK', async () => {
    await expect(db.insert(sites).values({ orgId: orgA, legalEntityId: leB, name: 'cross' })).rejects.toThrow(
      /foreign key/,
    );
  });

  it('cannot update or delete another org rows (silently 0 rows)', async () => {
    const updated = await withTenant(db, { orgId: orgA, userId: userA }, (tx) =>
      tx.update(sites).set({ name: 'hacked' }).where(eq(sites.orgId, orgB)).returning(),
    );
    expect(updated).toHaveLength(0);
  });

  it('lets a user list their own orgs without an org selected', async () => {
    const orgs = await withUser(db, userA, (tx) => tx.select().from(organizations));
    expect(orgs.map((o) => o.id)).toEqual([orgA]);
  });

  it('hides users from other orgs', async () => {
    const visible = await withTenant(db, { orgId: orgA, userId: userA }, (tx) => tx.select().from(users));
    expect(visible.map((u) => u.id)).toEqual([userA]);
    expect(visible.map((u) => u.id)).not.toContain(userB);
  });

  it('shows system roles to every tenant but forbids editing them', async () => {
    const visible = await withTenant(db, { orgId: orgB, userId: userB }, (tx) => tx.select().from(roles));
    expect(visible.some((r) => r.key === 'org_admin')).toBe(true);
    const changed = await withTenant(db, { orgId: orgB, userId: userB }, (tx) =>
      tx.update(roles).set({ permissions: [] }).where(eq(roles.key, 'org_admin')).returning(),
    );
    expect(changed).toHaveLength(0);
  });
});

describe('audit log', () => {
  it('is append-only even for the table owner', async () => {
    const [ev] = await db
      .insert(auditEvents)
      .values({ orgId: orgA, action: 'test', entityType: 'site', entityId: 'x' })
      .returning();
    await expect(db.update(auditEvents).set({ action: 'tampered' }).where(eq(auditEvents.id, ev!.id))).rejects.toThrow(
      /append-only/,
    );
    await expect(db.delete(auditEvents).where(eq(auditEvents.id, ev!.id))).rejects.toThrow(/append-only/);
    await expect(db.execute(sql`TRUNCATE audit_events`)).rejects.toThrow(/append-only/);
  });
});
