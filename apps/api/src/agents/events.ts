import { events, type Tx } from '@boh/db';
import type { AccessContext } from '../common/access.js';

/** Domain event types agents can subscribe to. */
export type EventType = 'price.changed' | 'supplier_item.created' | 'item.created' | 'stock.changed' | 'po.status_changed' | 'po.received' | 'po.supplier_replied';

/**
 * Emit a domain event in the caller's transaction, so the event exists
 * if and only if the change it describes was committed.
 */
export async function emitEvent(
  tx: Tx,
  /** Who caused it. 'integration' with no user: an outside party (e.g. a supplier replying on WhatsApp). */
  access: { orgId: string; userId: string | null; actorType: AccessContext['actorType'] | 'integration' },
  type: EventType,
  entity: { type: string; id: string },
  payload: Record<string, unknown>,
): Promise<void> {
  await tx.insert(events).values({
    orgId: access.orgId,
    type,
    entityType: entity.type,
    entityId: entity.id,
    payload,
    actorType: access.actorType,
    actorUserId: access.userId,
  });
}
