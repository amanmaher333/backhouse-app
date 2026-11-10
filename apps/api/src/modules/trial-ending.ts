import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import { memberships, organizations, subscriptions, trialNotices, userChannels, users } from '@boh/db';
import { clip, formatMoney, monthlySavingsLines, templateParam, TRIAL_REMINDER_DAYS, trialReminderDue, WA_LIMITS } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService } from '../common/db.service.js';
import { AccessContext } from '../common/access.js';
import { loadGrants } from '../common/grants.js';
import { BillingService } from '../billing/billing.service.js';
import { ChannelsService } from '../channels/channels.service.js';
import type { MessageContent } from '../channels/transport.js';
import { SavingsService } from './savings.js';

type Lang = 'ar' | 'en';
type Report = Awaited<ReturnType<SavingsService['report']>>;
const langOf = (l: string | null | undefined): Lang => (l === 'en' ? 'en' : 'ar');
const localDate = (t: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);

export interface TrialEndingFacts {
  orgName: string;
  endsAt: Date;
  timeZone: string;
  /** A card is on file and an interval chosen: the plan starts by itself. */
  planChosen: boolean;
  interval: string | null;
  report: Report;
}

/**
 * "Your trial ends soon" on WhatsApp, a few days before the end, to the people who decide on billing:
 * what Kitchain saved during the trial against the monthly price, and a link to choose a plan.
 * If a plan is already chosen it says so and asks for nothing. Sent once per person and organisation.
 */
@Injectable()
export class TrialEndingService {
  private readonly logger = new Logger('TrialEnding');

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly channels: ChannelsService,
    private readonly savings: SavingsService,
    private readonly billing: BillingService,
  ) {}

  render(f: TrialEndingFacts, lang: Lang): MessageContent {
    const ar = lang === 'ar';
    const r = f.report;
    const money = (v: string) => formatMoney(v, r.currency, lang);
    const date = f.endsAt.toLocaleDateString(ar ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: f.timeZone });
    const days = Math.max(1, Math.ceil((f.endsAt.getTime() - Date.now()) / 86400_000));
    const saved = r.totals.saved;
    const price = r.trial?.monthlyPrice ?? r.totals.planMonthly ?? '0';
    const all = monthlySavingsLines(r.totals, lang, money);
    // What is still being claimed isn't part of the total: it goes on its own line.
    const claimed = Number(r.totals.inProgress) > 0 ? all.at(-1)! : null;
    const lines = claimed ? all.slice(0, -1) : all;
    const out = [`⏳ *${f.orgName}* · ${ar ? `تنتهي فترتك التجريبية في ${date}` : `Your Kitchain trial ends on ${date}`}`, ''];
    if (Number(saved) > 0) {
      out.push(ar ? `حتى الآن وفّر لك Kitchain *${money(saved)}*:` : `So far Kitchain has saved you *${money(saved)}*:`, ...lines.map((l) => `• ${l}`), '');
    }
    if (claimed) out.push(claimed, '');
    const multiple = r.trial?.multiple ?? null;
    if (f.planChosen) {
      const kind = f.interval === 'year' ? (ar ? 'السنوية' : 'annual') : ar ? 'الشهرية' : 'monthly';
      out.push(ar ? `باقتك ${kind} تبدأ تلقائيًا في ${date}. لا تحتاج لفعل شيء.` : `Your ${kind} plan starts by itself on ${date}. Nothing to do.`);
    } else {
      const covered = multiple !== null && multiple >= 1 ? (ar ? `، وما وفّرته يغطيها ${multiple} أضعاف` : `; what you saved already covers it ${multiple}×`) : '';
      out.push(
        ar ? `الباقة ${money(price)} شهريًا${covered}.` : `The plan is ${money(price)} a month${covered}.`,
        ar ? `باقي ${days} ${days === 1 ? 'يوم' : 'أيام'}. اختر باقة ليستمر وكلاؤك في العمل:` : `${days} ${days === 1 ? 'day' : 'days'} left. Choose a plan to keep your agents working:`,
      );
    }
    out.push(`${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/billing`);
    return {
      lang,
      text: clip(out.join('\n'), WA_LIMITS.body),
      template: {
        name: this.config.WHATSAPP_TEMPLATE_TRIAL_ENDING,
        bodyParams: [templateParam(f.orgName, 100), templateParam(date, 40), templateParam(money(saved), 40), templateParam(money(price), 40)],
        quickReplyPayloads: [],
        urlSuffix: 'billing',
      },
    };
  }

  /** The trial's savings and price for one person in one org (null if they can't decide on billing or see prices). */
  async facts(orgId: string, userId: string, timeZone: string, now: Date): Promise<TrialEndingFacts | null> {
    const grants = await this.db.system((tx) => loadGrants(tx, orgId, userId));
    const access = new AccessContext(orgId, userId, grants, 'trial-ending', undefined);
    if (!access.can('billing:manage') || !access.can('price:read')) return null;
    const sub = await this.billing.status(orgId);
    if (sub.status !== 'trialing' || !sub.trialEndsAt) return null;
    const [org] = await this.db.system((tx) => tx.select().from(organizations).where(eq(organizations.id, orgId)));
    const [user] = await this.db.system((tx) => tx.select({ locale: users.locale }).from(users).where(eq(users.id, userId)));
    const started = await this.billing.trialStartedAt(orgId);
    const report = await this.savings.report(access, { from: localDate(started, timeZone), to: localDate(now, timeZone) }, now);
    const lang = langOf(user?.locale);
    return {
      orgName: lang === 'ar' ? (org!.nameAr ?? org!.name) : org!.name,
      endsAt: new Date(sub.trialEndsAt),
      timeZone,
      planChosen: Boolean(sub.hasPaymentMethod && sub.interval),
      interval: sub.interval ?? null,
      report,
    };
  }

  /** Worker: remind people whose trial ends within a few days. A trial_notices row makes it once only. */
  async runDue(now = new Date()): Promise<number> {
    const soon = new Date(now.getTime() + TRIAL_REMINDER_DAYS * 86400_000);
    const rows = await this.db.system((tx) =>
      tx
        .select({ orgId: subscriptions.orgId, endsAt: subscriptions.trialEndsAt, user: users, channel: userChannels })
        .from(subscriptions)
        .innerJoin(memberships, eq(memberships.orgId, subscriptions.orgId))
        .innerJoin(users, eq(users.id, memberships.userId))
        .innerJoin(userChannels, and(eq(userChannels.userId, users.id), eq(userChannels.channel, 'whatsapp')))
        .where(
          and(
            eq(subscriptions.status, 'trialing'),
            gt(subscriptions.trialEndsAt, now),
            lte(subscriptions.trialEndsAt, soon),
            eq(users.isActive, true),
            eq(users.kind, 'human'),
            sql`not exists (select 1 from trial_notices n where n.user_id = ${users.id} and n.org_id = ${subscriptions.orgId} and n.kind = 'trial_ending')`,
          ),
        ),
    );
    let sent = 0;
    for (const { orgId, endsAt, user, channel } of rows) {
      if (!trialReminderDue(now, endsAt!, channel.timeZone, channel.digestHour)) continue;
      try {
        const f = await this.facts(orgId, user.id, channel.timeZone, now);
        const id = await this.db.system(async (tx) => {
          const details = f ? { saved: f.report.totals.saved, monthlyPrice: f.report.trial?.monthlyPrice ?? null, planChosen: f.planChosen, endsAt: f.endsAt.toISOString() } : { skipped: 'not a billing manager' };
          const [claim] = await tx.insert(trialNotices).values({ userId: user.id, orgId, kind: 'trial_ending', details }).onConflictDoNothing().returning();
          if (!claim || !f) return null;
          const content = this.render(f, langOf(user.locale));
          const msgId = await this.channels.queue(tx, { orgId, userId: user.id, to: channel.address, kind: 'trial_ending', content });
          await tx.update(trialNotices).set({ outboundMessageId: msgId }).where(eq(trialNotices.id, claim.id));
          return msgId;
        });
        if (id) sent++;
      } catch (err) {
        this.logger.error(`trial ending ${user.id}/${orgId}: ${(err as Error).message}`);
      }
    }
    return sent;
  }
}
