import { BadRequestException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import {
  agentRuns,
  agentTasks,
  agents,
  corrections,
  events,
  memberships,
  roles,
  users,
  subscriptions,
  type AgentAction,
  type AutonomyLevel,
  type Tx,
} from '@boh/db';
import { DbService } from '../common/db.service.js';
import { AccessContext } from '../common/access.js';
import { audit, auditRaw } from '../common/audit.js';
import { LlmWriter } from './llm.js';
import { ENTITLED_STATUSES } from '../billing/billing.service.js';
import { AGENT_DEFINITIONS, getDefinition } from './registry.js';
import type { AgentDefinition, AgentOutput, AgentRow, AgentServices, RunContext, TaskProposal, TaskRow } from './types.js';
import { ProcurementService } from '../modules/procurement.js';
import { StockService } from '../modules/stock.js';
import { SupplierMessenger } from '../channels/supplier-messenger.js';
import { InvoicesService } from '../invoices/invoices.service.js';
import { FoodCostService } from '../modules/food-cost.js';
import { RecipesService } from '../modules/recipes.js';
import { StockCountsService } from '../modules/stock-counts.js';

const OPEN = ['proposed', 'approved'] as const;

/** Where a decision was made. */
export type DecisionVia = 'web' | 'whatsapp' | 'api';

function normalize(o: AgentOutput): { proposals: TaskProposal[]; expirePrefixes?: string[] } {
  return Array.isArray(o) ? { proposals: o } : o;
}

export interface RunSummary {
  runId: number;
  status: 'succeeded' | 'failed' | 'skipped';
  eventsProcessed: number;
  tasksCreated: number;
  tasksUpdated: number;
  actionsExecuted: number;
  costUsd: number;
  error?: string;
}

/**
 * Agent runtime: hiring agents (identity + role), running them on events,
 * schedules or on demand, storing deduplicated tasks, applying autonomy and
 * guardrails, and recording usage and cost per run.
 */
@Injectable()
export class AgentRuntime {
  private readonly logger = new Logger('AgentRuntime');

  private readonly services: AgentServices;

  constructor(
    private readonly db: DbService,
    private readonly llm: LlmWriter,
    procurement: ProcurementService,
    stock: StockService,
    messenger: SupplierMessenger,
    invoices: InvoicesService,
    foodCost: FoodCostService,
    recipes: RecipesService,
    stockCounts: StockCountsService,
  ) {
    this.services = { procurement, stock, messenger, invoices, foodCost, recipes, stockCounts };
  }

  // ---------- identities ----------

  /** Access context for an agent's own identity, with the permissions of its agent role. */
  async agentAccess(tx: Tx, agent: AgentRow, requestId: string): Promise<AccessContext> {
    const def = this.def(agent.kind);
    const [role] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, def.roleKey)));
    if (!role) throw new Error(`Agent role ${def.roleKey} missing; run migrations`);
    return new AccessContext(agent.orgId, agent.userId, [{ roleKey: role.key, scope: 'org', permissions: role.permissions, siteIds: null }], requestId, undefined, 'agent');
  }

  def(kind: string): AgentDefinition {
    const d = getDefinition(kind);
    if (!d) throw new NotFoundException(`Unknown agent kind "${kind}"`);
    return d;
  }

  autonomyFor(agent: AgentRow, type: string): AutonomyLevel {
    const def = this.def(agent.kind);
    const at = def.actionTypes.find((a) => a.type === type);
    const chosen = agent.autonomy[type];
    if (at && chosen && at.allowed.includes(chosen)) return chosen;
    return at?.default ?? 'approve';
  }

  // ---------- hiring / configuring ----------

  catalog() {
    return AGENT_DEFINITIONS.map((d) => ({
      kind: d.kind,
      name: d.name,
      nameAr: d.nameAr,
      description: d.description,
      descriptionAr: d.descriptionAr,
      subscribes: d.subscribes,
      actionTypes: d.actionTypes,
      defaultSettings: d.defaultSettings,
    }));
  }

  async list(a: AccessContext) {
    return this.db.tenant(a.tenant, async (tx) => {
      const rows = await tx
        .select({
          agent: agents,
          // Single-table selects render columns unqualified, so the outer id is named explicitly
          // (otherwise "id" inside the subquery would bind to the subquery's own table).
          openTasks: sql<number>`(select count(*)::int from agent_tasks t where t.agent_id = "agents"."id" and t.status in ('proposed','approved'))`,
          last30Cost: sql<string>`(select coalesce(sum(r.cost_usd), 0)::text from agent_runs r where r.agent_id = "agents"."id" and r.started_at > now() - interval '30 days')`,
          executed30: sql<number>`(select count(*)::int from agent_tasks t where t.agent_id = "agents"."id" and t.status = 'executed' and t.updated_at > now() - interval '30 days')`,
        })
        .from(agents)
        .orderBy(asc(agents.createdAt));
      const installed = rows.map((r) => ({
        ...r.agent,
        autonomy: Object.fromEntries(this.def(r.agent.kind).actionTypes.map((t) => [t.type, this.autonomyFor(r.agent, t.type)])),
        settings: { ...this.def(r.agent.kind).defaultSettings, ...r.agent.settings },
        openTasks: r.openTasks,
        last30CostUsd: Number(r.last30Cost),
        executed30: r.executed30,
      }));
      return { installed, available: this.catalog(), llm: this.llm.mode };
    });
  }

  /** Hire an agent: creates its identity (a user that cannot log in) and its membership with the agent role. */
  async install(a: AccessContext, kind: string) {
    const def = this.def(kind);
    const agent = await this.db.system(async (tx) => {
      const existing = await tx.select().from(agents).where(and(eq(agents.orgId, a.orgId), eq(agents.kind, kind)));
      if (existing.length) throw new BadRequestException('This agent is already hired');
      const [role] = await tx.select().from(roles).where(and(isNull(roles.orgId), eq(roles.key, def.roleKey)));
      if (!role) throw new Error(`Agent role ${def.roleKey} missing; run migrations`);
      const [user] = await tx
        .insert(users)
        .values({ email: `agent-${randomBytes(8).toString('hex')}@agents.boh.local`, fullName: def.name, kind: 'agent', passwordHash: null })
        .returning();
      await tx.insert(memberships).values({ orgId: a.orgId, userId: user!.id, roleId: role.id });
      // Start after existing events: history is covered by the initial scan below.
      const [maxEvt] = await tx.select({ id: sql<number>`coalesce(max(${events.id}), 0)::bigint` }).from(events).where(eq(events.orgId, a.orgId));
      const [row] = await tx
        .insert(agents)
        .values({ orgId: a.orgId, kind, name: def.name, nameAr: def.nameAr, userId: user!.id, autonomy: {}, settings: {}, eventCursor: Number(maxEvt?.id ?? 0), createdBy: a.userId })
        .returning();
      await auditRaw(tx, { orgId: a.orgId, userId: a.userId, requestId: a.requestId, ip: a.ip, action: 'agent.hired', entityType: 'agent', entityId: row!.id, after: row });
      return row!;
    });
    const firstRun = await this.run(agent.id, 'install', { scan: true });
    return { agent, firstRun };
  }

  async update(a: AccessContext, id: string, dto: { status?: 'active' | 'paused'; autonomy?: Record<string, AutonomyLevel>; settings?: Record<string, unknown> }) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select().from(agents).where(eq(agents.id, id));
      if (!before) throw new NotFoundException('agent not found');
      const def = this.def(before.kind);
      const values: Partial<typeof agents.$inferInsert> = {};
      if (dto.status) values.status = dto.status;
      if (dto.autonomy) {
        for (const [type, level] of Object.entries(dto.autonomy)) {
          const at = def.actionTypes.find((t) => t.type === type);
          if (!at) throw new BadRequestException(`Unknown action type "${type}"`);
          if (!at.allowed.includes(level)) throw new BadRequestException(`"${type}" cannot be set to ${level}`);
        }
        values.autonomy = { ...before.autonomy, ...dto.autonomy };
      }
      if (dto.settings) {
        for (const [k, v] of Object.entries(dto.settings)) {
          if (!(k in def.defaultSettings)) throw new BadRequestException(`Unknown setting "${k}"`);
          if (typeof v !== typeof def.defaultSettings[k]) throw new BadRequestException(`Setting "${k}" has the wrong type`);
          if (typeof v === 'number' && (v < 0 || v > 1000)) throw new BadRequestException(`Setting "${k}" is out of range`);
        }
        values.settings = { ...before.settings, ...dto.settings };
      }
      if (Object.keys(values).length === 0) return before;
      const [after] = await tx.update(agents).set(values).where(eq(agents.id, id)).returning();
      await audit(tx, a, { action: dto.status && dto.status !== before.status ? `agent.${dto.status}` : 'agent.updated', entityType: 'agent', entityId: id, before, after });
      return after;
    });
  }

  /** Let an agent go: removes its membership and deactivates its identity. Its task history is kept in the audit log. */
  async remove(a: AccessContext, id: string) {
    await this.db.system(async (tx) => {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, id), eq(agents.orgId, a.orgId)));
      if (!agent) throw new NotFoundException('agent not found');
      await tx.delete(memberships).where(and(eq(memberships.userId, agent.userId), eq(memberships.orgId, a.orgId)));
      await tx.update(users).set({ isActive: false }).where(eq(users.id, agent.userId));
      await tx.delete(agents).where(eq(agents.id, id));
      await auditRaw(tx, { orgId: a.orgId, userId: a.userId, requestId: a.requestId, ip: a.ip, action: 'agent.removed', entityType: 'agent', entityId: id, before: agent });
    });
  }

  runs(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, (tx) => tx.select().from(agentRuns).where(eq(agentRuns.agentId, id)).orderBy(desc(agentRuns.id)).limit(50));
  }

  // ---------- running ----------

  /**
   * Run one agent: process new events (and optionally scan history), store tasks,
   * auto-execute what autonomy allows, and record the run. Safe to call
   * concurrently: a per-agent advisory lock makes overlapping runs skip.
   */
  async run(agentId: string, trigger: string, opts: { scan?: boolean } = {}): Promise<RunSummary> {
    const [agent] = await this.db.system((tx) => tx.select().from(agents).where(eq(agents.id, agentId)));
    if (!agent) throw new NotFoundException('agent not found');
    const def = this.def(agent.kind);
    const tenant = { orgId: agent.orgId, userId: agent.userId };

    try {
      return await this.db.tenant(tenant, async (tx) => {
        const [lock] = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${agentId})) as ok`).then((r: any) => r.rows ?? r);
        if (!lock?.ok) return { runId: 0, status: 'skipped', eventsProcessed: 0, tasksCreated: 0, tasksUpdated: 0, actionsExecuted: 0, costUsd: 0 } as RunSummary;
        const [fresh] = await tx.select().from(agents).where(eq(agents.id, agentId));
        if (!fresh || fresh.status !== 'active') {
          return { runId: 0, status: 'skipped', eventsProcessed: 0, tasksCreated: 0, tasksUpdated: 0, actionsExecuted: 0, costUsd: 0 } as RunSummary;
        }
        const [run] = await tx.insert(agentRuns).values({ orgId: agent.orgId, agentId, trigger }).returning();
        const access = await this.agentAccess(tx, fresh, `agent-run:${run!.id}`);
        const settings = { ...def.defaultSettings, ...fresh.settings };
        const ctx: RunContext = { tx, agent: fresh, access, settings, llm: this.llm, services: this.services, usage: { model: null, inputTokens: 0, outputTokens: 0, costUsd: 0 } };

        const newEvents = await tx
          .select()
          .from(events)
          .where(and(gt(events.id, fresh.eventCursor), inArray(events.type, def.subscribes)))
          .orderBy(asc(events.id))
          .limit(500);
        const outputs = [normalize(await def.handleEvents(ctx, newEvents)), ...(opts.scan && def.scan ? [normalize(await def.scan(ctx))] : [])];
        // A scan and an event may produce the same subject: keep the last.
        const bySubject = new Map(outputs.flatMap((o) => o.proposals).map((p) => [p.subjectKey, p]));

        let created = 0;
        let updated = 0;
        let executed = 0;
        for (const p of bySubject.values()) {
          const { task, isNew } = await this.upsertTask(tx, fresh, p);
          if (isNew) created++;
          else updated++;
          if (await this.autoExecute(tx, fresh, access, settings, task)) executed++;
        }
        // Subjects re-checked with nothing needed any more: their open, undecided tasks expire.
        const prefixes = [...new Set(outputs.flatMap((o) => o.expirePrefixes ?? []))];
        if (prefixes.length) {
          const open = await tx
            .select({ id: agentTasks.id, subjectKey: agentTasks.subjectKey })
            .from(agentTasks)
            .where(and(eq(agentTasks.agentId, agentId), eq(agentTasks.status, 'proposed')));
          const stale = open.filter((t) => prefixes.some((p) => t.subjectKey.startsWith(p)) && !bySubject.has(t.subjectKey)).map((t) => t.id);
          if (stale.length) await tx.update(agentTasks).set({ status: 'expired' }).where(inArray(agentTasks.id, stale));
        }

        const lastEventId = newEvents.length ? newEvents[newEvents.length - 1]!.id : fresh.eventCursor;
        // If the batch was full, there may be more; the cursor still only moves past what was processed.
        await tx.update(agents).set({ eventCursor: lastEventId, lastRunAt: new Date() }).where(eq(agents.id, agentId));
        await tx
          .update(agentRuns)
          .set({
            status: 'succeeded',
            eventsProcessed: newEvents.length,
            tasksCreated: created,
            tasksUpdated: updated,
            actionsExecuted: executed,
            model: ctx.usage.model,
            inputTokens: ctx.usage.inputTokens,
            outputTokens: ctx.usage.outputTokens,
            costUsd: ctx.usage.costUsd.toFixed(6),
            finishedAt: new Date(),
          })
          .where(eq(agentRuns.id, run!.id));
        return { runId: run!.id, status: 'succeeded', eventsProcessed: newEvents.length, tasksCreated: created, tasksUpdated: updated, actionsExecuted: executed, costUsd: ctx.usage.costUsd } as RunSummary;
      });
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`Agent ${agentId} run failed: ${message}`);
      const [failed] = await this.db.tenant(tenant, (tx) =>
        tx.insert(agentRuns).values({ orgId: agent.orgId, agentId, trigger, status: 'failed', error: message.slice(0, 2000), finishedAt: new Date() }).returning(),
      );
      return { runId: failed!.id, status: 'failed', eventsProcessed: 0, tasksCreated: 0, tasksUpdated: 0, actionsExecuted: 0, costUsd: 0, error: message };
    }
  }

  private async upsertTask(tx: Tx, agent: AgentRow, p: TaskProposal): Promise<{ task: TaskRow; isNew: boolean }> {
    const actions: AgentAction[] = p.actions.map((x) => ({ ...x, autonomy: this.autonomyFor(agent, x.type) }));
    const values = {
      kind: p.kind,
      priority: p.priority,
      title: p.title,
      titleAr: p.titleAr,
      summary: p.summary,
      summaryAr: p.summaryAr,
      evidence: p.evidence,
      actions,
      sourceEventId: p.sourceEventId ?? null,
      writtenBy: p.writtenBy,
    };
    const [open] = await tx
      .select()
      .from(agentTasks)
      .where(and(eq(agentTasks.agentId, agent.id), eq(agentTasks.subjectKey, p.subjectKey), inArray(agentTasks.status, [...OPEN])));
    if (open) {
      const [task] = await tx.update(agentTasks).set(values).where(eq(agentTasks.id, open.id)).returning();
      return { task: task!, isNew: false };
    }
    const [task] = await tx.insert(agentTasks).values({ ...values, orgId: agent.orgId, agentId: agent.id, subjectKey: p.subjectKey }).returning();
    return { task: task!, isNew: true };
  }

  /** Run the first action whose autonomy is "auto", if its guardrail allows. */
  private async autoExecute(tx: Tx, agent: AgentRow, access: AccessContext, settings: Record<string, unknown>, task: TaskRow): Promise<boolean> {
    const action = task.actions.find((x) => x.autonomy === 'auto');
    if (!action) return false;
    const def = this.def(agent.kind);
    const ectx = { tx, agent, access, task, settings, services: this.services, automatic: true };
    const blocked = await def.guardrail(action, ectx);
    if (blocked) {
      await tx.update(agentTasks).set({ result: { autoBlocked: blocked, actionId: action.id } }).where(eq(agentTasks.id, task.id));
      return false;
    }
    const result = await def.execute(action, ectx);
    await tx
      .update(agentTasks)
      .set({ status: 'executed', chosenActionId: action.id, result: { ...result, automatic: true }, executedAt: new Date(), decidedAt: new Date(), decidedVia: 'auto' })
      .where(eq(agentTasks.id, task.id));
    await audit(tx, access, { action: `agent_task.auto_executed`, entityType: 'agent_task', entityId: task.id, after: { actionId: action.id, type: action.type, result } });
    return true;
  }

  /** Called by the worker: run every active agent that has unprocessed events, plus daily scans. */
  async runDue(): Promise<RunSummary[]> {
    const due = await this.db.system(async (tx) => {
      // Agents of organisations without an active subscription do not run.
      const active = await tx
        .select({ agent: agents })
        .from(agents)
        .innerJoin(subscriptions, eq(subscriptions.orgId, agents.orgId))
        .where(and(eq(agents.status, 'active'), inArray(subscriptions.status, [...ENTITLED_STATUSES])))
        .then((rows) => rows.map((r) => r.agent));
      const out: { id: string; scan: boolean }[] = [];
      for (const ag of active) {
        const def = getDefinition(ag.kind);
        if (!def) continue;
        const [pending] = await tx
          .select({ id: events.id })
          .from(events)
          .where(and(eq(events.orgId, ag.orgId), gt(events.id, ag.eventCursor), inArray(events.type, def.subscribes)))
          .limit(1);
        const [lastScan] = await tx
          .select({ at: agentRuns.startedAt })
          .from(agentRuns)
          .where(and(eq(agentRuns.agentId, ag.id), inArray(agentRuns.trigger, ['install', 'schedule', 'manual'])))
          .orderBy(desc(agentRuns.id))
          .limit(1);
        const scanDue = Boolean(def.scan) && (!lastScan || Date.now() - lastScan.at.getTime() > 24 * 3600_000);
        if (pending || scanDue) out.push({ id: ag.id, scan: scanDue });
      }
      return out;
    });
    const results: RunSummary[] = [];
    for (const d of due) results.push(await this.run(d.id, d.scan ? 'schedule' : 'event', { scan: d.scan }));
    return results;
  }

  // ---------- tasks ----------

  listTasks(a: AccessContext, q: { status: 'open' | 'closed' | 'all'; agentId?: string; limit: number }) {
    return this.db.tenant(a.tenant, (tx) => {
      const conds = [];
      if (q.status === 'open') conds.push(inArray(agentTasks.status, [...OPEN]));
      if (q.status === 'closed') conds.push(sql`${agentTasks.status} not in ('proposed','approved')`);
      if (q.agentId) conds.push(eq(agentTasks.agentId, q.agentId));
      return tx
        .select({ task: agentTasks, agentKind: agents.kind, agentName: agents.name, agentNameAr: agents.nameAr, agentStatus: agents.status })
        .from(agentTasks)
        .innerJoin(agents, eq(agents.id, agentTasks.agentId))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(q.status === 'open' ? asc(agentTasks.priority) : desc(agentTasks.updatedAt), desc(agentTasks.updatedAt))
        .limit(q.limit)
        .then((rows) => rows.map((r) => ({ ...r.task, agent: { kind: r.agentKind, name: r.agentName, nameAr: r.agentNameAr, status: r.agentStatus } })));
    });
  }

  async countOpen(a: AccessContext) {
    const [r] = await this.db.tenant(a.tenant, (tx) => tx.select({ n: sql<number>`count(*)::int` }).from(agentTasks).where(inArray(agentTasks.status, [...OPEN])));
    return { open: r?.n ?? 0 };
  }

  async getTask(a: AccessContext, id: string) {
    const [row] = await this.listTasksById(a, id);
    if (!row) throw new NotFoundException('task not found');
    return row;
  }

  private listTasksById(a: AccessContext, id: string) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({ task: agentTasks, agentKind: agents.kind, agentName: agents.name, agentNameAr: agents.nameAr, agentStatus: agents.status })
        .from(agentTasks)
        .innerJoin(agents, eq(agents.id, agentTasks.agentId))
        .where(eq(agentTasks.id, id))
        .then((rows) => rows.map((r) => ({ ...r.task, agent: { kind: r.agentKind, name: r.agentName, nameAr: r.agentNameAr, status: r.agentStatus } }))),
    );
  }

  /** A person approves one proposed action; the agent carries it out under its own identity. */
  async approve(a: AccessContext, taskId: string, actionId: string, via: DecisionVia = 'web') {
    return this.db.tenant(a.tenant, async (tx) => {
      const [task] = await tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)).for('update');
      if (!task) throw new NotFoundException('task not found');
      if (task.status !== 'proposed') throw new BadRequestException(`Task is already ${task.status}`);
      const [agent] = await tx.select().from(agents).where(eq(agents.id, task.agentId));
      if (!agent) throw new NotFoundException('agent not found');
      if (agent.status !== 'active') throw new BadRequestException('This agent is paused; resume it to carry out actions');
      const action = task.actions.find((x) => x.id === actionId);
      if (!action) throw new BadRequestException('Unknown action');
      const def = this.def(agent.kind);
      const at = def.actionTypes.find((t) => t.type === action.type);
      if (this.autonomyFor(agent, action.type) === 'suggest') throw new BadRequestException('This action is set to "suggest only"; carry it out yourself and mark the task done');
      if (at?.requires && !a.can(at.requires)) throw new ForbiddenException(`Approving this needs ${at.requires}`);
      const agentAccess = await this.agentAccess(tx, agent, a.requestId);
      if (at?.requires && !agentAccess.can(at.requires)) throw new ForbiddenException('The agent role does not allow this action');
      const settings = { ...def.defaultSettings, ...agent.settings };
      const ectx = { tx, agent, access: agentAccess, task, settings, services: this.services, automatic: false, approver: a };

      await this.recordDecision(tx, a, task, { decision: 'approved', actionId, actionType: action.type, via });
      const blocked = await def.guardrail(action, ectx);
      if (blocked) {
        const [failed] = await tx
          .update(agentTasks)
          .set({ status: 'failed', chosenActionId: actionId, error: blocked, decidedBy: a.userId, decidedAt: new Date(), decidedVia: via })
          .where(eq(agentTasks.id, taskId))
          .returning();
        await audit(tx, a, { action: 'agent_task.blocked', entityType: 'agent_task', entityId: taskId, after: { actionId, reason: blocked } });
        return failed;
      }
      const result = await def.execute(action, ectx);
      const [done] = await tx
        .update(agentTasks)
        .set({ status: 'executed', chosenActionId: actionId, result, decidedBy: a.userId, decidedAt: new Date(), executedAt: new Date(), decidedVia: via })
        .where(eq(agentTasks.id, taskId))
        .returning();
      await audit(tx, a, { action: 'agent_task.approved', entityType: 'agent_task', entityId: taskId, after: { actionId, type: action.type, via } });
      return done;
    });
  }

  async reject(a: AccessContext, taskId: string, reason: string | null, via: DecisionVia = 'web') {
    return this.close(a, taskId, 'rejected', reason, via);
  }

  async dismiss(a: AccessContext, taskId: string, note: string | null, via: DecisionVia = 'web') {
    return this.close(a, taskId, 'dismissed', note, via);
  }

  private async close(a: AccessContext, taskId: string, status: 'rejected' | 'dismissed', note: string | null, via: DecisionVia) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [task] = await tx.select().from(agentTasks).where(eq(agentTasks.id, taskId)).for('update');
      if (!task) throw new NotFoundException('task not found');
      if (!OPEN.includes(task.status as (typeof OPEN)[number])) throw new BadRequestException(`Task is already ${task.status}`);
      await this.recordDecision(tx, a, task, { decision: status, note, via });
      const [after] = await tx
        .update(agentTasks)
        .set({ status, decidedBy: a.userId, decidedAt: new Date(), decisionNote: note, decidedVia: via })
        .where(eq(agentTasks.id, taskId))
        .returning();
      await audit(tx, a, { action: `agent_task.${status}`, entityType: 'agent_task', entityId: taskId, after: { note, via } });
      return after;
    });
  }

  /** Every decision on agent output is training and evaluation data. */
  private async recordDecision(tx: Tx, a: AccessContext, task: TaskRow, human: Record<string, unknown>) {
    await tx.insert(corrections).values({
      orgId: a.orgId,
      kind: 'agent_decision',
      subjectType: 'agent_task',
      subjectId: task.id,
      input: { kind: task.kind, evidence: task.evidence },
      modelOutput: { title: task.title, summary: task.summary, actions: task.actions, writtenBy: task.writtenBy },
      humanOutput: human,
      userId: a.userId,
    });
  }
}
