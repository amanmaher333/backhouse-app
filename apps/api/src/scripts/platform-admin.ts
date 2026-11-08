/**
 * Make an existing user a BOH platform admin (can review company checks).
 * Usage: pnpm --filter @boh/api platform:admin someone@boh.sa
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import { createDb, memberships, organizations, roles, users } from '@boh/db';
import { loadConfig } from '../config.js';

const email = process.argv[2];
if (!email) {
  console.error('Usage: platform:admin <email>');
  process.exit(1);
}
const { db, pool } = createDb(loadConfig().DATABASE_URL, 1);
try {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);
    if (!user) throw new Error(`No user ${email}; they must sign up first`);
    let [org] = await tx.select().from(organizations).where(eq(organizations.type, 'platform')).limit(1);
    if (!org) [org] = await tx.insert(organizations).values({ type: 'platform', name: 'BOH', nameAr: 'بوه' }).returning();
    const [role] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, 'org_admin')));
    await tx.insert(memberships).values({ orgId: org!.id, userId: user.id, roleId: role!.id }).onConflictDoNothing();
    console.log(`${email} is now a BOH platform admin (org ${org!.id})`);
  });
} finally {
  await pool.end();
}
