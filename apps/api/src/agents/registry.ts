import { priceWatch } from './price-watch.js';
import { purchasing } from './purchasing.js';
import { invoice } from './invoice.js';
import { costController } from './cost-controller.js';
import type { AgentDefinition } from './types.js';

/** Agents customers can hire. New agents register here. */
export const AGENT_DEFINITIONS: AgentDefinition[] = [priceWatch, purchasing, invoice, costController];

export function getDefinition(kind: string): AgentDefinition | undefined {
  return AGENT_DEFINITIONS.find((d) => d.kind === kind);
}
