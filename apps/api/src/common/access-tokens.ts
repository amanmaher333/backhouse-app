import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { accessTokens, memberships, users } from '@boh/db';
import { DbService } from './db.service.js';

/**
 * Personal access tokens for API and MCP clients. A token is bound to one user
 * in one org and carries exactly that user's permissions there. Only a SHA-256
 * hash is stored; the token is shown once at creation.
 */
export const PAT_PREFIX = 'boh_pat_';

export function newAccessToken(): { token: string; prefix: string; hash: string } {
  const token = PAT_PREFIX + randomBytes(32).toString('base64url');
  return { token, prefix: token.slice(0, PAT_PREFIX.length + 6), hash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

@Injectable()
export class AccessTokenVerifier {
  constructor(private readonly db: DbService) {}

  /** Returns the user and org for a valid token, or null. Runs on the owner connection (no tenant yet). */
  async verify(token: string): Promise<{ userId: string; orgId: string } | null> {
    return this.db.system(async (tx) => {
      const [row] = await tx
        .select({ id: accessTokens.id, userId: accessTokens.userId, orgId: accessTokens.orgId, expiresAt: accessTokens.expiresAt, lastUsedAt: accessTokens.lastUsedAt, active: users.isActive, kind: users.kind })
        .from(accessTokens)
        .innerJoin(users, eq(users.id, accessTokens.userId))
        .where(and(eq(accessTokens.tokenHash, hashToken(token)), isNull(accessTokens.revokedAt)));
      if (!row || !row.active || row.kind !== 'human') return null;
      if (row.expiresAt && row.expiresAt <= new Date()) return null;
      // The user must still be a member of the org.
      const [m] = await tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.userId, row.userId), eq(memberships.orgId, row.orgId)))
        .limit(1);
      if (!m) return null;
      // Record use at most once a minute.
      if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 60_000) {
        await tx.update(accessTokens).set({ lastUsedAt: new Date() }).where(eq(accessTokens.id, row.id));
      }
      return { userId: row.userId, orgId: row.orgId };
    });
  }
}
