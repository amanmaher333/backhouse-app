import { priceWatch } from './price-watch.js';
import type { AgentDefinition } from './types.js';

/** Agents customers can hire. New agents register here. */
export const AGENT_DEFINITIONS: AgentDefinition[] = [priceWatch];

export function getDefinition(kind: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((d) => d.kind === kind);
}
