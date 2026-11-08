import { and, eq, isNull } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { roles } from './schema.js';
import { SYSTEM_ROLES } from './permissions.js';

/** Upsert built-in roles (org_id NULL). Must run with owner (non-RLS) privileges. */
export async function syncSystemRoles(db: NodePgDatabase<any>): Promise<void> {
  for (const r of SYSTEM_ROLES) {
    const existing = await db
      .select({ id: roles.id })
      .from(roles)
      .where(and(isNull(roles.orgId), eq(roles.key, r.key)));
    const values = { name: r.name, nameAr: r.nameAr, scope: r.scope, permissions: r.permissions, isSystem: true };
    if (existing[0]) {
      await db.update(roles).set(values).where(eq(roles.id, existing[0].id));
    } else {
      await db.insert(roles).values({ key: r.key, orgId: null, ...values });
    }
  }
}
