import { auditEvents, type Tx } from '@boh/db';
import type { AccessContext } from './access.js';

export interface AuditInput {
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

const REDACT = new Set(['passwordHash', 'tokenHash', 'password_hash', 'token_hash']);

function clean(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  return JSON.parse(JSON.stringify(v, (k, val) => (REDACT.has(k) ? '[redacted]' : val)));
}

/** Write an audit event in the same transaction as the change it records. */
export async function audit(tx: Tx, access: AccessContext, e: AuditInput): Promise<void> {
  await tx.insert(auditEvents).values({
    orgId: access.orgId,
    actorType: 'user',
    actorUserId: access.userId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    before: clean(e.before),
    after: clean(e.after),
    requestId: access.requestId,
    ip: access.ip ?? null,
  });
}

/** For flows before an AccessContext exists (signup, invitation accept). */
export async function auditRaw(
  tx: Tx,
  e: AuditInput & { orgId: string; userId: string | null; requestId?: string; ip?: string },
): Promise<void> {
  await tx.insert(auditEvents).values({
    orgId: e.orgId,
    actorType: e.userId ? 'user' : 'system',
    actorUserId: e.userId,
    action: e.action,
    entityType: e.entityType,
    entityId: e.entityId ?? null,
    before: clean(e.before),
    after: clean(e.after),
    requestId: e.requestId ?? null,
    ip: e.ip ?? null,
  });
}
