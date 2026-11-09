import type { AgentAction, AutonomyLevel, Tx, agents, agentTasks, events } from '@boh/db';
import type { AccessContext } from '../common/access.js';
import type { ProcurementService } from '../modules/procurement.js';
import type { SupplierMessenger } from '../channels/supplier-messenger.js';
import type { StockService } from '../modules/stock.js';
import type { LlmWriter } from './llm.js';
import type { InvoicesService } from '../invoices/invoices.service.js';

export type AgentRow = typeof agents.$inferSelect;
export type TaskRow = typeof agentTasks.$inferSelect;
export type EventRow = typeof events.$inferSelect;

export interface ActionTypeDef {
  type: string;
  label: string;
  labelAr: string;
  /** Autonomy levels a customer may choose for this action. */
  allowed: AutonomyLevel[];
  default: AutonomyLevel;
  /** Permission the approving person must hold (besides task:decide). */
  requires?: string;
}

/** A proposed task, before the runtime stores it. */
export interface TaskProposal {
  kind: string;
  subjectKey: string;
  priority: number;
  title: string;
  titleAr: string;
  summary: string;
  summaryAr: string;
  evidence: Record<string, unknown>;
  actions: Omit<AgentAction, 'autonomy'>[];
  sourceEventId?: number;
  writtenBy: 'claude' | 'template';
}

/**
 * What an agent returns from a run. `expirePrefixes`: subjects the agent
 * re-checked; open, undecided tasks under these prefixes that were not
 * proposed again are no longer needed and expire.
 */
export type AgentOutput = TaskProposal[] | { proposals: TaskProposal[]; expirePrefixes?: string[] };

/** Domain services agents use, so they act through the same rules as people. */
export interface AgentServices {
  procurement: ProcurementService;
  stock: StockService;
  /** Sends approved messages to suppliers on WhatsApp. */
  messenger: SupplierMessenger;
  /** Supplier invoices: matching, approval, credit-note requests. */
  invoices: InvoicesService;
}

export interface RunContext {
  tx: Tx;
  agent: AgentRow;
  /** The agent's own identity: permissions of its agent role, audited as actor_type = agent. */
  access: AccessContext;
  settings: Record<string, unknown>;
  llm: LlmWriter;
  services: AgentServices;
  usage: { model: string | null; inputTokens: number; outputTokens: number; costUsd: number };
}

export interface ExecuteContext {
  tx: Tx;
  agent: AgentRow;
  access: AccessContext;
  task: TaskRow;
  settings: Record<string, unknown>;
  services: AgentServices;
  /** True when the agent runs the action on its own (autonomy = auto), with no person approving. */
  automatic: boolean;
  /** The person who approved, when there is one (for site-level permission checks). */
  approver?: AccessContext;
}

export interface AgentDefinition {
  kind: string;
  name: string;
  nameAr: string;
  description: string;
  descriptionAr: string;
  roleKey: string;
  /** Event types the agent reacts to. */
  subscribes: string[];
  actionTypes: ActionTypeDef[];
  defaultSettings: Record<string, unknown>;
  /** Turn new events into task proposals. */
  handleEvents(ctx: RunContext, events: EventRow[]): Promise<AgentOutput>;
  /** Look back over existing data (first install, daily, or "run now"). */
  scan?(ctx: RunContext): Promise<AgentOutput>;
  /** Hard limits checked before any execution, whatever the autonomy. Returns a reason to block, or null. */
  guardrail(action: AgentAction, ctx: ExecuteContext): Promise<string | null>;
  /** Carry out an action through domain commands. Returns a result to store on the task. */
  execute(action: AgentAction, ctx: ExecuteContext): Promise<Record<string, unknown>>;
}
