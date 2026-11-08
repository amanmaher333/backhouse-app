import type { AgentAction, AutonomyLevel, Tx, agents, agentTasks, events } from '@boh/db';
import type { AccessContext } from '../common/access.js';
import type { LlmWriter } from './llm.js';

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

export interface RunContext {
  tx: Tx;
  agent: AgentRow;
  /** The agent's own identity: permissions of its agent role, audited as actor_type = agent. */
  access: AccessContext;
  settings: Record<string, unknown>;
  llm: LlmWriter;
  usage: { model: string | null; inputTokens: number; outputTokens: number; costUsd: number };
}

export interface ExecuteContext {
  tx: Tx;
  agent: AgentRow;
  access: AccessContext;
  task: TaskRow;
  settings: Record<string, unknown>;
  /** True when the agent runs the action on its own (autonomy = auto), with no person approving. */
  automatic: boolean;
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
  handleEvents(ctx: RunContext, events: EventRow[]): Promise<TaskProposal[]>;
  /** Look back over existing data (first install or "run now"). */
  scan?(ctx: RunContext): Promise<TaskProposal[]>;
  /** Hard limits checked before any execution, whatever the autonomy. Returns a reason to block, or null. */
  guardrail(action: AgentAction, ctx: ExecuteContext): Promise<string | null>;
  /** Carry out an action through domain commands. Returns a result to store on the task. */
  execute(action: AgentAction, ctx: ExecuteContext): Promise<Record<string, unknown>>;
}
