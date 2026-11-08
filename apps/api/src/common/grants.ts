import { and, eq } from 'drizzle-orm';
import { memberships, roles, type Tx } from '@boh/db';
import type { Grant } from './access.js';

/** A user's grants in one org (empty when not a member). Run inside a tenant or system transaction. */
export async function loadGrants(tx: Tx, orgId: string, userId: string): Promise<Grant[]> {
  const rows = await tx
    .select({ roleKey: roles.key, scope: roles.scope, permissions: roles.permissions, siteIds: memberships.siteIds })
    .from(memberships)
    .innerJoin(roles, eq(roles.id, memberships.roleId))
    .where(and(eq(memberships.userId, userId), eq(memberships.orgId, orgId)));
  return rows.map((r) => ({ roleKey: r.roleKey, scope: r.scope, permissions: r.permissions, siteIds: r.siteIds }));
}
