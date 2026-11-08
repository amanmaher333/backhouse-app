import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import * as schema from './schema.js';

export * as schema from './schema.js';
export * from './schema.js';
export * from './permissions.js';
export { syncSystemRoles } from './system-roles.js';
export { runMigrations } from './migrator.js';
export { syncCanonicalIngredients } from './canonical-sync.js';
export { CANONICAL_SEED } from './canonical-seed.js';

export type Db = NodePgDatabase<typeof schema>;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];

export interface DbHandle {
  db: Db;
  pool: pg.Pool;
}

export function createDb(connectionString: string, max = 10): DbHandle {
  const pool = new pg.Pool({ connectionString, max });
  return { db: drizzle(pool, { schema }), pool };
}

export interface TenantContext {
  orgId: string;
  userId: string;
}

/**
 * Run `fn` in a transaction as the RLS-restricted boh_app role, scoped to one org.
 * Every tenant request must go through this.
 */
export async function withTenant<T>(db: Db, ctx: TenantContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE boh_app`);
    await tx.execute(
      sql`SELECT set_config('app.org_id', ${ctx.orgId}, true), set_config('app.user_id', ${ctx.userId}, true)`,
    );
    return fn(tx);
  });
}

/** RLS-restricted, user-scoped but no org selected (e.g. listing "my orgs"). */
export async function withUser<T>(db: Db, userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SET LOCAL ROLE boh_app`);
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
}
