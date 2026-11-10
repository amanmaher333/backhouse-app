import { BadRequestException, HttpException, Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  agents,
  agentTasks,
  approvalPrompts,
  channelLinkCodes,
  inboundMessages,
  memberships,
  organizations,
  outboundMessages,
  userChannels,
  users,
  type AgentAction,
  type Tx,
} from '@boh/db';
import { COUNTRIES, findLinkCode, inServiceWindow, linkCode, normalizePhone, parseApprovalPayload, parseDigestPayload, parseSupplierPayload, waId } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService } from '../common/db.service.js';
import { AccessContext } from '../common/access.js';
import { loadGrants } from '../common/grants.js';
import { audit } from '../common/audit.js';
import { AgentRuntime } from '../agents/runtime.js';
import { getDefinition } from '../agents/registry.js';
import { approvalCard, replies, taskLink, taskValue } from './cards.js';
import { SupplierMessenger } from './supplier-messenger.js';
import { SendError, WHATSAPP_TRANSPORT, type MessageContent, type SendForm, type WhatsAppTransport } from './transport.js';

type Lang = 'ar' | 'en';
const lang = (l: string | null | undefined): Lang => (l === 'en' ? 'en' : 'ar');
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const DEFAULT_WHATSAPP_APPROVAL_MAX = 5000;
const LINK_CODE_TTL_MIN = 15;
const MAX_ATTEMPTS = 5;
const MAX_RECIPIENTS = 10;
const SHOW_DECISIONS_MAX = 5;
/** Messages Kitchain starts itself: free-form only inside the 24-hour window, a template otherwise. */
const SCHEDULED_KINDS = new Set(['approval_card', 'digest', 'monthly_savings', 'trial_ending', 'supplier_order', 'supplier_followup', 'supplier_update']);

/** One message as the webhook delivers it (the parts Kitchain uses). */
export interface InboundMessage {
  id: string;
  from: string;
  type: string;
  timestamp?: string;
  text?: { body?: string };
  button?: { payload?: string; text?: string };
  interactive?: { type?: string; button_reply?: { id?: string; title?: string } };
  context?: { id?: string };
}

interface StatusUpdate {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  errors?: { code?: number; title?: string; message?: string }[];
}

const STATUS_RANK: Record<string, number> = { queued: 0, simulated: 1, sent: 1, delivered: 2, read: 3, failed: 4 };

const STOP_WORDS = new Set(['stop', 'إيقاف', 'ايقاف', 'توقف']);
const START_WORDS = new Set(['start', 'تشغيل', 'ابدأ']);

/**
 * WhatsApp approvals. A person links their number by sending a one-time code from it.
 * When an agent proposes something that needs a decision, everyone who could approve it
 * (and has WhatsApp approvals on) gets a card with Approve / Reject buttons. A tap is
 * carried out through the same runtime path as the web inbox, with that person's own
 * permissions, and recorded as decided via WhatsApp.
 */
/** Time zone of a phone number's country (longest matching dialling code), else Riyadh. */
function timeZoneForPhone(e164: string): string {
  const digits = e164.replace(/^\+/, '');
  const match = Object.values(COUNTRIES)
    .filter((c) => digits.startsWith(c.phoneCode))
    .sort((a, b) => b.phoneCode.length - a.phoneCode.length)[0];
  return match?.timezone ?? 'Asia/Riyadh';
}

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger('WhatsApp');

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(WHATSAPP_TRANSPORT) private readonly transport: WhatsAppTransport,
    private readonly runtime: AgentRuntime,
    private readonly suppliers: SupplierMessenger,
  ) {}

  get mode() {
    return this.transport.mode;
  }

  status() {
    return {
      mode: this.transport.mode,
      businessNumber: this.config.WHATSAPP_BUSINESS_NUMBER,
      webhookReady: Boolean(this.config.WHATSAPP_APP_SECRET && this.config.WHATSAPP_VERIFY_TOKEN),
      simulator: this.simulatorEnabled,
    };
  }

  get simulatorEnabled() {
    return this.transport.mode === 'simulated' && this.config.NODE_ENV !== 'production';
  }

  // ---------- the person's own channel ----------

  async myChannel(userId: string) {
    const [row] = await this.db.user(userId, (tx) => tx.select().from(userChannels).where(and(eq(userChannels.userId, userId), eq(userChannels.channel, 'whatsapp'))));
    return {
      ...this.status(),
      linked: row
        ? {
            address: row.address,
            verifiedAt: row.verifiedAt,
            approvalsEnabled: row.approvalsEnabled,
            digestEnabled: row.digestEnabled,
            digestHour: row.digestHour,
            monthlySavingsEnabled: row.monthlySavingsEnabled,
            timeZone: row.timeZone,
            windowOpen: inServiceWindow(row.lastInboundAt),
          }
        : null,
    };
  }

  /** Start linking: a one-time code the person sends to Kitchain's number from their WhatsApp. */
  async startLink(userId: string) {
    const code = linkCode(randomBytes(6));
    const expiresAt = new Date(Date.now() + LINK_CODE_TTL_MIN * 60_000);
    await this.db.system(async (tx) => {
      await tx.delete(channelLinkCodes).where(and(eq(channelLinkCodes.userId, userId), isNull(channelLinkCodes.usedAt)));
      await tx.insert(channelLinkCodes).values({ userId, channel: 'whatsapp', codeHash: sha256(code), expiresAt });
    });
    return { code, expiresAt, waLink: `https://wa.me/${waId(this.config.WHATSAPP_BUSINESS_NUMBER)}?text=${encodeURIComponent(code)}`, businessNumber: this.config.WHATSAPP_BUSINESS_NUMBER };
  }

  async updateMine(userId: string, dto: { approvalsEnabled?: boolean; digestEnabled?: boolean; digestHour?: number; monthlySavingsEnabled?: boolean; timeZone?: string }) {
    const [row] = await this.db.user(userId, (tx) =>
      tx.update(userChannels).set(dto).where(and(eq(userChannels.userId, userId), eq(userChannels.channel, 'whatsapp'))).returning(),
    );
    if (!row) throw new NotFoundException('WhatsApp is not linked');
    return this.myChannel(userId);
  }

  async unlink(userId: string) {
    await this.db.user(userId, (tx) => tx.delete(userChannels).where(and(eq(userChannels.userId, userId), eq(userChannels.channel, 'whatsapp'))));
    return this.myChannel(userId);
  }

  // ---------- org settings and log ----------

  async orgSettings(a: AccessContext) {
    const [org] = await this.db.tenant(a.tenant, (tx) => tx.select({ settings: organizations.settings }).from(organizations).where(eq(organizations.id, a.orgId)));
    return { whatsappApprovalMax: org?.settings.whatsappApprovalMax ?? DEFAULT_WHATSAPP_APPROVAL_MAX };
  }

  async updateOrgSettings(a: AccessContext, dto: { whatsappApprovalMax: number }) {
    return this.db.tenant(a.tenant, async (tx) => {
      const [before] = await tx.select().from(organizations).where(eq(organizations.id, a.orgId));
      if (!before) throw new NotFoundException();
      const settings = { ...before.settings, whatsappApprovalMax: dto.whatsappApprovalMax };
      await tx.update(organizations).set({ settings }).where(eq(organizations.id, a.orgId));
      await audit(tx, a, { action: 'org.settings_updated', entityType: 'organization', entityId: a.orgId, before: before.settings, after: settings });
      return { whatsappApprovalMax: dto.whatsappApprovalMax };
    });
  }

  messages(a: AccessContext, limit: number) {
    return this.db.tenant(a.tenant, (tx) =>
      tx
        .select({
          id: outboundMessages.id,
          kind: outboundMessages.kind,
          status: outboundMessages.status,
          sentAs: outboundMessages.sentAs,
          error: outboundMessages.error,
          taskId: outboundMessages.taskId,
          createdAt: outboundMessages.createdAt,
          sentAt: outboundMessages.sentAt,
          userName: users.fullName,
        })
        .from(outboundMessages)
        .leftJoin(users, eq(users.id, outboundMessages.userId))
        .where(eq(outboundMessages.orgId, a.orgId))
        .orderBy(desc(outboundMessages.createdAt))
        .limit(limit),
    );
  }

  // ---------- approval cards (worker) ----------

  /**
   * Send cards for new tasks that need a decision. Each task is handled once (notified_at),
   * whether or not anyone could be reached.
   */
  async notifyPending(): Promise<number> {
    let prompts = 0;
    await this.db.system(async (tx) => {
      const tasks = await tx
        .select({ task: agentTasks, agent: agents, org: organizations })
        .from(agentTasks)
        .innerJoin(agents, eq(agents.id, agentTasks.agentId))
        .innerJoin(organizations, eq(organizations.id, agentTasks.orgId))
        .where(
          and(
            eq(agentTasks.status, 'proposed'),
            isNull(agentTasks.notifiedAt),
            gt(agentTasks.createdAt, sql`now() - interval '7 days'`),
            // No cards for organisations whose subscription is inactive.
            sql`exists (select 1 from subscriptions s where s.org_id = ${agentTasks.orgId} and s.status in ('free','trialing','active','past_due'))`,
          ),
        )
        .orderBy(asc(agentTasks.createdAt))
        .limit(50)
        .for('update', { of: agentTasks, skipLocked: true });
      for (const { task, agent, org } of tasks) {
        await tx.update(agentTasks).set({ notifiedAt: new Date() }).where(eq(agentTasks.id, task.id));
        if (!decisionAction(task, agent)) continue;
        const people = await tx
          .select({ user: users, channel: userChannels })
          .from(memberships)
          .innerJoin(users, eq(users.id, memberships.userId))
          .innerJoin(userChannels, and(eq(userChannels.userId, users.id), eq(userChannels.channel, 'whatsapp')))
          .where(and(eq(memberships.orgId, task.orgId), eq(users.kind, 'human'), eq(users.isActive, true), eq(userChannels.approvalsEnabled, true)));
        let sent = 0;
        for (const { user, channel } of people) {
          if (sent >= MAX_RECIPIENTS) break;
          const access = new AccessContext(task.orgId, user.id, await loadGrants(tx, task.orgId, user.id), 'whatsapp-notify', undefined);
          if (!canDecide(access, task, agent)) continue;
          if (await this.queueCard(tx, { task, agent, org, user, channel, refresh: false })) {
            sent++;
            prompts++;
          }
        }
      }
    });
    return prompts;
  }

  /** Open tasks in an org this person may decide, oldest first. */
  async waitingFor(tx: Tx, access: AccessContext) {
    const rows = await tx
      .select({ task: agentTasks, agent: agents })
      .from(agentTasks)
      .innerJoin(agents, eq(agents.id, agentTasks.agentId))
      .where(and(eq(agentTasks.orgId, access.orgId), eq(agentTasks.status, 'proposed')))
      .orderBy(asc(agentTasks.priority), asc(agentTasks.createdAt));
    return rows.filter((r) => canDecide(access, r.task, r.agent));
  }

  /**
   * Queue an approval card for one person (creating its prompt). With refresh, an unused
   * prompt from earlier gets a new expiry and the card is sent again.
   */
  async queueCard(
    tx: Tx,
    p: { task: TaskRowLike; agent: AgentRowLike; org: OrgRowLike; user: UserRowLike; channel: { address: string }; refresh: boolean },
  ): Promise<string | null> {
    const action = decisionAction(p.task, p.agent);
    if (!action) return null;
    const cap = p.org.settings.whatsappApprovalMax ?? DEFAULT_WHATSAPP_APPROVAL_MAX;
    const canApprove = taskValue(p.task, action) <= cap;
    const expiresAt = new Date(Date.now() + this.config.WHATSAPP_PROMPT_TTL_HOURS * 3600_000);
    const insert = tx.insert(approvalPrompts).values({ orgId: p.task.orgId, userId: p.user.id, taskId: p.task.id, actionId: action.id, canApprove, expiresAt });
    const [prompt] = p.refresh
      ? await insert
          .onConflictDoUpdate({ target: [approvalPrompts.taskId, approvalPrompts.userId], set: { expiresAt, canApprove, actionId: action.id }, where: isNull(approvalPrompts.usedAt) })
          .returning()
      : await insert.onConflictDoNothing().returning();
    if (!prompt) return null;
    const l = lang(p.user.locale);
    const content = approvalCard({
      lang: l,
      task: p.task,
      action,
      agentName: p.agent.name,
      agentNameAr: p.agent.nameAr ?? p.agent.name,
      orgName: l === 'ar' ? (p.org.nameAr ?? p.org.name) : p.org.name,
      promptId: prompt.id,
      canApprove,
      cap,
      webUrl: this.config.PUBLIC_WEB_URL,
      templates: { approval: this.config.WHATSAPP_TEMPLATE_APPROVAL, notice: this.config.WHATSAPP_TEMPLATE_NOTICE },
    });
    return this.queue(tx, { orgId: p.task.orgId, userId: p.user.id, to: p.channel.address, kind: 'approval_card', taskId: p.task.id, content });
  }

  /** "Show decisions" on a digest: re-send cards for what is waiting (the tap opened the 24-hour window). */
  private async showDecisions(
    orgId: string,
    from: string,
    reply: (to: string, userId: string | null, orgId: string | null, kind: string, text: string) => Promise<unknown>,
    queued: string[],
  ) {
    const result = await this.db.system(async (tx) => {
      const [channel] = await tx.select().from(userChannels).where(and(eq(userChannels.channel, 'whatsapp'), eq(userChannels.address, from)));
      if (!channel) return { outcome: 'unknown_sender' as const };
      const [user] = await tx.select().from(users).where(eq(users.id, channel.userId));
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, orgId));
      const grants = await loadGrants(tx, orgId, channel.userId);
      if (!user || !org || grants.length === 0) return { outcome: 'not_member' as const, user };
      const access = new AccessContext(orgId, user.id, grants, 'whatsapp-digest', undefined);
      const waiting = (await this.waitingFor(tx, access)).slice(0, SHOW_DECISIONS_MAX);
      const ids: string[] = [];
      for (const { task, agent } of waiting) {
        const msgId = await this.queueCard(tx, { task, agent, org, user, channel, refresh: true });
        if (msgId) ids.push(msgId);
      }
      return { outcome: ids.length ? ('cards_sent' as const) : ('nothing_waiting' as const), user, ids };
    });
    if (result.outcome === 'cards_sent') queued.push(...result.ids);
    const l = lang(result.user?.locale);
    if (result.outcome === 'nothing_waiting') await reply(from, result.user!.id, orgId, 'help', replies.nothingWaiting(l));
    else if (result.outcome === 'not_member') await reply(from, result.user?.id ?? null, null, 'help', replies.refused(l, l === 'ar' ? 'لم تعد عضوًا في هذه المؤسسة' : 'you are no longer a member of this organisation'));
    else if (result.outcome === 'unknown_sender') await reply(from, null, null, 'help', replies.unknown());
    return result.outcome;
  }

  async queue(tx: Tx, m: { orgId: string | null; userId: string | null; to: string; kind: string; taskId?: string | null; content: MessageContent }) {
    const [row] = await tx
      .insert(outboundMessages)
      .values({ orgId: m.orgId, userId: m.userId, channel: 'whatsapp', toAddress: m.to, kind: m.kind, taskId: m.taskId ?? null, content: m.content as unknown as Record<string, unknown> })
      .returning({ id: outboundMessages.id });
    return row!.id;
  }

  // ---------- delivery (worker, and right after replies) ----------

  /** Send queued messages that are due. Picks interactive/text inside the 24-hour window, the template outside it. */
  async deliver(ids?: string[]): Promise<number> {
    let delivered = 0;
    await this.db.system(async (tx) => {
      const due = await tx
        // The window is per number: a linked person's last message, or for suppliers the message log.
        .select({
          msg: outboundMessages,
          lastInboundAt: sql<Date | null>`coalesce(${userChannels.lastInboundAt}, (select max(i.received_at) from inbound_messages i where i.from_address = ${outboundMessages.toAddress}))`.mapWith(
            (v) => (v ? new Date(v) : null),
          ),
        })
        .from(outboundMessages)
        .leftJoin(userChannels, and(eq(userChannels.channel, 'whatsapp'), eq(userChannels.address, outboundMessages.toAddress)))
        .where(and(eq(outboundMessages.status, 'queued'), lte(outboundMessages.nextAttemptAt, new Date()), ids?.length ? inArray(outboundMessages.id, ids) : undefined))
        .orderBy(asc(outboundMessages.createdAt))
        .limit(25)
        .for('update', { of: outboundMessages, skipLocked: true });
      for (const { msg, lastInboundAt } of due) {
        const content = msg.content as unknown as MessageContent;
        // Replies to someone who just wrote are always inside the window, linked or not;
        // messages Kitchain starts (cards, digests) check it.
        const windowOpen = !SCHEDULED_KINDS.has(msg.kind) || inServiceWindow(lastInboundAt);
        const form: SendForm | null = windowOpen ? (content.buttons?.length ? 'interactive' : 'text') : content.template ? 'template' : null;
        if (!form) {
          await tx.update(outboundMessages).set({ status: 'failed', error: 'Outside the 24-hour window and no template', attempts: msg.attempts + 1 }).where(eq(outboundMessages.id, msg.id));
          continue;
        }
        try {
          const { providerMessageId } = await this.transport.send(msg.toAddress, content, form);
          await tx
            .update(outboundMessages)
            .set({ status: this.transport.mode === 'simulated' ? 'simulated' : 'sent', sentAs: form, providerMessageId, sentAt: new Date(), attempts: msg.attempts + 1, error: null })
            .where(eq(outboundMessages.id, msg.id));
          delivered++;
        } catch (err) {
          const e = err as Error;
          const attempts = msg.attempts + 1;
          const retry = err instanceof SendError && err.retryable && attempts < MAX_ATTEMPTS;
          this.logger.warn(`send ${msg.id} failed (${attempts}): ${e.message}`);
          await tx
            .update(outboundMessages)
            .set(retry ? { attempts, error: e.message.slice(0, 500), nextAttemptAt: new Date(Date.now() + 2 ** attempts * 60_000) } : { attempts, status: 'failed', error: e.message.slice(0, 500) })
            .where(eq(outboundMessages.id, msg.id));
        }
      }
    });
    return delivered;
  }

  // ---------- webhook ----------

  /** Meta's subscription check: echo the challenge when the verify token matches. */
  verifySubscription(mode: string | undefined, token: string | undefined, challenge: string | undefined): string {
    const expected = this.config.WHATSAPP_VERIFY_TOKEN;
    if (!expected) throw new ServiceUnavailableException('WhatsApp webhook is not configured');
    if (mode !== 'subscribe' || !token || !safeEqual(token, expected) || !challenge) throw new UnauthorizedException('Verification failed');
    return challenge;
  }

  /** Checks X-Hub-Signature-256 (HMAC-SHA256 of the raw body with the app secret). */
  verifySignature(raw: Buffer | undefined, header: string | undefined) {
    const secret = this.config.WHATSAPP_APP_SECRET;
    if (!secret) throw new ServiceUnavailableException('WhatsApp webhook is not configured');
    if (!raw || !header?.startsWith('sha256=')) throw new UnauthorizedException('Missing signature');
    const expected = createHmac('sha256', secret).update(raw).digest('hex');
    if (!safeEqual(header.slice(7), expected)) throw new UnauthorizedException('Bad signature');
  }

  /** Process a verified webhook body. Errors in one message do not stop the others. */
  async handleWebhook(body: any): Promise<{ messages: number; statuses: number }> {
    let messages = 0;
    let statuses = 0;
    if (body?.object !== 'whatsapp_business_account') return { messages, statuses };
    for (const entry of body.entry ?? []) {
      for (const change of entry.changes ?? []) {
        const value = change.value ?? {};
        const phoneId = value.metadata?.phone_number_id;
        if (this.config.WHATSAPP_PHONE_NUMBER_ID && phoneId && phoneId !== this.config.WHATSAPP_PHONE_NUMBER_ID) continue;
        for (const st of (value.statuses ?? []) as StatusUpdate[]) {
          await this.applyStatus(st).catch((e) => this.logger.error(`status ${st.id}: ${(e as Error).message}`));
          statuses++;
        }
        for (const m of (value.messages ?? []) as InboundMessage[]) {
          await this.processInbound(m).catch((e) => this.logger.error(`message ${m.id}: ${(e as Error).message}`));
          messages++;
        }
      }
    }
    return { messages, statuses };
  }

  private async applyStatus(st: StatusUpdate) {
    await this.db.system(async (tx) => {
      const [msg] = await tx.select().from(outboundMessages).where(eq(outboundMessages.providerMessageId, st.id));
      // Webhooks can arrive out of order: never move backwards (read → delivered).
      if (!msg || (STATUS_RANK[st.status] ?? 0) <= (STATUS_RANK[msg.status] ?? 0)) return;
      const err = st.errors?.[0];
      await tx
        .update(outboundMessages)
        .set({ status: st.status, ...(err ? { error: `${err.code ?? ''} ${err.title ?? err.message ?? ''}`.trim() } : {}) })
        .where(eq(outboundMessages.id, msg.id));
    });
  }

  /**
   * Handle one inbound message: record it once (providers retry), refresh the person's
   * 24-hour window, then act on a button tap, a link code or a keyword.
   */
  async processInbound(m: InboundMessage): Promise<string> {
    const from = normalizePhone(`+${m.from.replace(/^\+/, '')}`) ?? `+${m.from.replace(/^\+/, '')}`;
    const payload = m.button?.payload ?? m.interactive?.button_reply?.id ?? null;
    const text = m.text?.body ?? m.button?.text ?? '';

    const recorded = await this.db.system(async (tx) => {
      const [row] = await tx
        .insert(inboundMessages)
        .values({ channel: 'whatsapp', providerMessageId: m.id, fromAddress: from, type: m.type, payload: m as unknown as Record<string, unknown> })
        .onConflictDoNothing()
        .returning({ id: inboundMessages.id });
      if (!row) return null;
      const [channel] = await tx
        .update(userChannels)
        .set({ lastInboundAt: new Date() })
        .where(and(eq(userChannels.channel, 'whatsapp'), eq(userChannels.address, from)))
        .returning();
      const [user] = channel ? await tx.select().from(users).where(eq(users.id, channel.userId)) : [];
      if (channel) await tx.update(inboundMessages).set({ userId: channel.userId }).where(eq(inboundMessages.id, row.id));
      return { rowId: row.id, channel: channel ?? null, user: user ?? null };
    });
    if (!recorded) return 'duplicate';

    let outcome: string;
    const replyIds: string[] = [];
    const reply = async (to: string, userId: string | null, orgId: string | null, kind: string, text: string, taskId?: string) =>
      replyIds.push(await this.db.system((tx) => this.queue(tx, { orgId, userId, to, kind, taskId, content: { lang: 'en', text } })));

    const l = lang(recorded.user?.locale);
    const approval = payload ? parseApprovalPayload(payload) : null;
    const code = !payload ? findLinkCode(text) : null;
    const word = text.trim().toLowerCase();

    const digestOrg = payload ? parseDigestPayload(payload) : null;
    const supplierAnswer = payload ? parseSupplierPayload(payload) : null;
    // Numbers that are not Kitchain users may be suppliers answering an order.
    const supplier =
      !recorded.channel && !code && (supplierAnswer || !payload)
        ? await this.suppliers.handleInbound({ from, inboundId: recorded.rowId, answer: supplierAnswer ?? undefined, text })
        : null;
    if (supplier) {
      outcome = `supplier:${supplier.outcome}`;
      replyIds.push(...supplier.ids);
    } else if (approval) {
      outcome = await this.decide(approval.promptId, approval.decision, from, m.id, reply);
    } else if (digestOrg) {
      outcome = await this.showDecisions(digestOrg, from, reply, replyIds);
    } else if (code) {
      outcome = await this.link(code, from, reply, recorded.user?.locale);
    } else if (!recorded.channel) {
      await reply(from, null, null, 'help', replies.unknown());
      outcome = 'unknown_sender';
    } else if (STOP_WORDS.has(word) || START_WORDS.has(word)) {
      const enabled = START_WORDS.has(word);
      await this.db.system((tx) => tx.update(userChannels).set({ approvalsEnabled: enabled }).where(eq(userChannels.id, recorded.channel!.id)));
      await reply(from, recorded.channel.userId, null, 'help', enabled ? replies.resumed(l) : replies.paused(l));
      outcome = enabled ? 'resumed' : 'paused';
    } else {
      await reply(from, recorded.channel.userId, null, 'help', replies.help(l, recorded.channel.approvalsEnabled));
      outcome = 'help';
    }
    await this.db.system((tx) => tx.update(inboundMessages).set({ outcome }).where(eq(inboundMessages.id, recorded.rowId)));
    if (replyIds.length) await this.deliver(replyIds);
    return outcome;
  }

  private async link(
    code: string,
    from: string,
    reply: (to: string, userId: string | null, orgId: string | null, kind: string, text: string) => Promise<unknown>,
    senderLocale?: string,
  ): Promise<string> {
    const result = await this.db.system(async (tx) => {
      const [row] = await tx
        .select()
        .from(channelLinkCodes)
        .where(and(eq(channelLinkCodes.codeHash, sha256(code)), isNull(channelLinkCodes.usedAt), gt(channelLinkCodes.expiresAt, new Date())))
        .for('update');
      if (!row) return { outcome: 'bad_code' as const };
      const [taken] = await tx.select().from(userChannels).where(and(eq(userChannels.channel, 'whatsapp'), eq(userChannels.address, from)));
      const [user] = await tx.select().from(users).where(eq(users.id, row.userId));
      if (!user || !user.isActive || user.kind !== 'human') return { outcome: 'bad_code' as const };
      if (taken && taken.userId !== row.userId) return { outcome: 'number_taken' as const, user };
      await tx.update(channelLinkCodes).set({ usedAt: new Date() }).where(eq(channelLinkCodes.id, row.id));
      const now = new Date();
      await tx
        .insert(userChannels)
        // The digest's local hour starts in the time zone of the number's country (changeable in settings).
        .values({ userId: row.userId, channel: 'whatsapp', address: from, verifiedAt: now, lastInboundAt: now, timeZone: timeZoneForPhone(from) })
        .onConflictDoUpdate({ target: [userChannels.userId, userChannels.channel], set: { address: from, verifiedAt: now, lastInboundAt: now, approvalsEnabled: true } });
      await tx
        .update(inboundMessages)
        .set({ userId: row.userId })
        .where(and(eq(inboundMessages.fromAddress, from), isNull(inboundMessages.userId)));
      return { outcome: 'linked' as const, user };
    });
    // Answer in the sender's language when we know it; a new link uses the account's.
    const l = lang(result.outcome === 'linked' ? result.user?.locale : (senderLocale ?? result.user?.locale));
    if (result.outcome === 'linked') await reply(from, result.user!.id, null, 'link_confirm', replies.linked(l, result.user!.fullName));
    else if (result.outcome === 'number_taken') await reply(from, null, null, 'help', replies.numberTaken(l));
    else await reply(from, null, null, 'help', replies.badCode(l));
    return result.outcome;
  }

  /**
   * A button tap. Honoured only from the number the card was sent to, once, before it
   * expires, within the WhatsApp cap, and with the person's permissions right now.
   */
  private async decide(
    promptId: string,
    decision: 'approve' | 'reject',
    from: string,
    providerMessageId: string,
    reply: (to: string, userId: string | null, orgId: string | null, kind: string, text: string, taskId?: string) => Promise<unknown>,
  ): Promise<string> {
    const ctx = await this.db.system(async (tx) => {
      const [prompt] = await tx.select().from(approvalPrompts).where(eq(approvalPrompts.id, promptId));
      if (!prompt) return null;
      const [channel] = await tx.select().from(userChannels).where(and(eq(userChannels.userId, prompt.userId), eq(userChannels.channel, 'whatsapp')));
      const [user] = await tx.select().from(users).where(eq(users.id, prompt.userId));
      const [task] = await tx.select().from(agentTasks).where(eq(agentTasks.id, prompt.taskId));
      const grants = await loadGrants(tx, prompt.orgId, prompt.userId);
      return { prompt, channel, user, task, grants };
    });
    if (!ctx || !ctx.channel || ctx.channel.address !== from || !ctx.user) {
      await reply(from, null, null, 'help', replies.notYours(lang(ctx?.user?.locale)));
      return 'not_yours';
    }
    const { prompt, user, task } = ctx;
    const l = lang(user.locale);
    const link = taskLink(this.config.PUBLIC_WEB_URL, prompt.taskId);
    const say = (text: string) => reply(from, user.id, prompt.orgId, 'decision_reply', text, prompt.taskId);
    const title = task ? (l === 'ar' ? task.titleAr : task.title) : '';
    const mark = (outcome: string, used: boolean) =>
      this.db.system((tx) =>
        tx
          .update(approvalPrompts)
          .set(used ? { usedAt: new Date(), decision, outcome } : { outcome })
          .where(and(eq(approvalPrompts.id, prompt.id), isNull(approvalPrompts.usedAt))),
      );

    if (!task || task.status !== 'proposed') {
      await say(replies.alreadyDecided(l, title, task?.status ?? 'expired', task?.decidedVia ?? null));
      await mark('already_decided', false);
      return 'already_decided';
    }
    if (prompt.usedAt) {
      await say(replies.alreadyDecided(l, title, task.status, 'whatsapp'));
      return 'already_used';
    }
    if (prompt.expiresAt.getTime() < Date.now()) {
      await say(replies.expired(l, link));
      await mark('expired', false);
      return 'expired';
    }
    if (decision === 'approve' && !prompt.canApprove) {
      await say(replies.overCap(l, link));
      await mark('over_cap', false);
      return 'over_cap';
    }
    if (!user.isActive || ctx.grants.length === 0) {
      await say(replies.refused(l, l === 'ar' ? 'لم تعد عضوًا في هذه المؤسسة' : 'you are no longer a member of this organisation'));
      await mark('not_member', false);
      return 'not_member';
    }

    const access = new AccessContext(prompt.orgId, user.id, ctx.grants, `whatsapp:${providerMessageId}`, undefined);
    try {
      if (decision === 'approve') {
        const done = await this.runtime.approve(access, prompt.taskId, prompt.actionId, 'whatsapp');
        if (done?.status === 'failed') {
          await say(replies.blocked(l, title, done.error ?? ''));
          await mark('blocked', true);
          return 'blocked';
        }
        await say(replies.done(l, title, (done?.result as Record<string, unknown>) ?? null));
        await mark('approved', true);
        return 'approved';
      }
      await this.runtime.reject(access, prompt.taskId, l === 'ar' ? 'رُفض عبر واتساب' : 'Rejected on WhatsApp', 'whatsapp');
      await say(replies.rejected(l, title));
      await mark('rejected', true);
      return 'rejected';
    } catch (err) {
      const message = err instanceof HttpException ? err.message : 'unexpected error';
      if (!(err instanceof HttpException)) this.logger.error(`decide ${prompt.id}: ${(err as Error).message}`);
      await say(replies.refused(l, message));
      await mark(`refused: ${message}`.slice(0, 200), false);
      return 'refused';
    }
  }

  // ---------- simulator (development only) ----------

  /** The conversation between Kitchain and the person's phone, oldest first. */
  async simulatorThread(userId: string, address?: string) {
    this.assertSimulator();
    const mine = await this.myChannel(userId);
    const phone = mine.linked?.address ?? (address ? normalizePhone(address) : null);
    return this.db.system(async (tx) => {
      const out = await tx
        .select()
        .from(outboundMessages)
        .where(phone ? or(eq(outboundMessages.userId, userId), eq(outboundMessages.toAddress, phone)) : eq(outboundMessages.userId, userId))
        .orderBy(desc(outboundMessages.createdAt))
        .limit(40);
      const inbound = phone
        ? await tx.select().from(inboundMessages).where(eq(inboundMessages.fromAddress, phone)).orderBy(desc(inboundMessages.receivedAt)).limit(40)
        : [];
      const items = [
        ...out.map((m) => ({ id: m.id, dir: 'in' as const, at: m.createdAt, kind: m.kind, status: m.status, sentAs: m.sentAs, content: m.content as unknown as MessageContent })),
        ...inbound.map((m) => {
          const p = m.payload as unknown as InboundMessage;
          return { id: String(m.id), dir: 'out' as const, at: m.receivedAt, kind: m.type, status: m.outcome, sentAs: null, content: { lang: 'en' as const, text: p.text?.body ?? p.interactive?.button_reply?.title ?? p.button?.text ?? '' } };
        }),
      ].sort((a, b) => a.at.getTime() - b.at.getTime());
      return { phone, items: items.slice(-60) };
    });
  }

  /** Play the person's phone: send text or tap a button, as the webhook would deliver it. */
  async simulatorSend(userId: string, dto: { from?: string; text?: string; payload?: string; title?: string }) {
    this.assertSimulator();
    const mine = await this.myChannel(userId);
    const from = mine.linked?.address ?? (dto.from ? normalizePhone(dto.from) : null);
    if (!from) throw new BadRequestException('Enter the phone number you are sending from');
    const id = `sim.in.${randomUUID()}`;
    const m: InboundMessage = dto.payload
      ? { id, from: waId(from), type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: dto.payload, title: dto.title ?? '' } } }
      : { id, from: waId(from), type: 'text', text: { body: dto.text ?? '' } };
    const outcome = await this.processInbound(m);
    return { outcome };
  }

  private assertSimulator() {
    if (!this.simulatorEnabled) throw new NotFoundException();
  }
}

type TaskRowLike = typeof agentTasks.$inferSelect;
type AgentRowLike = typeof agents.$inferSelect;
type OrgRowLike = typeof organizations.$inferSelect;
type UserRowLike = typeof users.$inferSelect;

/** The action a card asks about: the first one set to "ask me", on an active agent. */
function decisionAction(task: TaskRowLike, agent: AgentRowLike): AgentAction | null {
  if (agent.status !== 'active' || !getDefinition(agent.kind)) return null;
  return task.actions.find((x) => x.autonomy === 'approve') ?? null;
}

/** Same rule as approving in the web inbox: task:decide plus the action's permission, for the task's site. */
export function canDecide(access: AccessContext, task: TaskRowLike, agent: AgentRowLike): boolean {
  const action = decisionAction(task, agent);
  if (!action) return false;
  const requires = getDefinition(agent.kind)!.actionTypes.find((t) => t.type === action.type)?.requires;
  const siteId = siteOf(task.evidence, action);
  return access.can('task:decide', siteId) && (!requires || access.can(requires, siteId));
}

function siteOf(evidence: Record<string, unknown>, action: AgentAction): string | undefined {
  const site = evidence.site as { id?: string } | undefined;
  return site?.id ?? ((action.params as Record<string, unknown>)?.siteId as string | undefined);
}

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
