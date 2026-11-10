import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { memberships, organizations, savingsReports, userChannels, users } from '@boh/db';
import { clip, formatMoney, monthlyReportDue, monthlySavingsLines, monthRange, savingsNothingToReport, templateParam, WA_LIMITS } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService } from '../common/db.service.js';
import { AccessContext } from '../common/access.js';
import { loadGrants } from '../common/grants.js';
import { ChannelsService } from '../channels/channels.service.js';
import type { MessageContent } from '../channels/transport.js';
import { SavingsService } from './savings.js';

type Lang = 'ar' | 'en';
type Report = Awaited<ReturnType<SavingsService['report']>>;
const langOf = (l: string | null | undefined): Lang => (l === 'en' ? 'en' : 'ar');

/**
 * The monthly savings report on WhatsApp: on the 1st, at the person's digest hour, last month's
 * savings for each organisation where they can see prices. Months with nothing saved and nothing
 * being claimed are recorded but not sent. See docs/savings.md.
 */
@Injectable()
export class MonthlySavingsService {
  private readonly logger = new Logger('MonthlySavings');

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly channels: ChannelsService,
    private readonly savings: SavingsService,
  ) {}

  render(r: Report, o: { lang: Lang; orgName: string; period: string }): MessageContent {
    const ar = o.lang === 'ar';
    const money = (v: string) => formatMoney(v, r.currency, o.lang);
    const month = new Date(`${o.period}-15T12:00:00Z`).toLocaleDateString(ar ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
    const lines = monthlySavingsLines(r.totals, o.lang, money);
    // What is still being claimed isn't part of the total: it goes on its own line.
    const claimed = Number(r.totals.inProgress) > 0 ? lines.at(-1)! : null;
    const savedLines = claimed ? lines.slice(0, -1) : lines;
    const saved = Number(r.totals.saved) > 0;
    const out = [`💰 *${o.orgName}* · ${ar ? `التوفير في ${month}` : `Savings in ${month}`}`, ''];
    out.push(saved ? (ar ? `وفّر لك Kitchain *${money(r.totals.saved)}*.` : `Kitchain saved you *${money(r.totals.saved)}*.`) : ar ? `لا يوجد توفير مؤكد في ${month}.` : `No confirmed savings in ${month}.`);
    if (savedLines.length) out.push(...savedLines.map((l) => `• ${l}`));
    if (claimed) out.push('', claimed);
    if (r.totals.multiple !== null && r.totals.multiple >= 1) out.push('', ar ? `أي ${r.totals.multiple} أضعاف تكلفة Kitchain في هذا الشهر.` : `That's ${r.totals.multiple}× what Kitchain cost that month.`);
    else if (r.trial) out.push('', ar ? `فترتك التجريبية حتى الآن: ${money(r.trial.saved)} توفير، والباقة ${money(r.trial.monthlyPrice)} شهريًا.` : `Your trial so far: ${money(r.trial.saved)} saved; the plan is ${money(r.trial.monthlyPrice)} a month.`);
    const suffix = `savings?from=${r.period.from}&to=${r.period.to}`;
    out.push('', `${ar ? 'التفاصيل' : 'Details'}: ${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/${suffix}`);
    return {
      lang: o.lang,
      text: clip(out.join('\n'), WA_LIMITS.body),
      template: {
        name: this.config.WHATSAPP_TEMPLATE_SAVINGS,
        bodyParams: [templateParam(o.orgName, 100), templateParam(month, 40), templateParam(money(r.totals.saved), 40), templateParam(lines.join(' · ') || (ar ? 'لا شيء' : 'None'), 600)],
        quickReplyPayloads: [],
        urlSuffix: suffix,
      },
    };
  }

  private async reportFor(orgId: string, userId: string, period: { from: string; to: string }, now: Date) {
    const grants = await this.db.system((tx) => loadGrants(tx, orgId, userId));
    const access = new AccessContext(orgId, userId, grants, 'monthly-savings', undefined);
    if (!access.can('price:read')) return null;
    return this.savings.report(access, period, now);
  }

  /**
   * Worker: send reports that are due. A savings_reports row claims each person/org/month,
   * so several workers or restarts never send twice.
   */
  async runDue(now = new Date()): Promise<number> {
    const people = await this.db.system((tx) =>
      tx
        .select({ user: users, channel: userChannels })
        .from(userChannels)
        .innerJoin(users, eq(users.id, userChannels.userId))
        .where(and(eq(userChannels.channel, 'whatsapp'), eq(userChannels.monthlySavingsEnabled, true), eq(users.isActive, true), eq(users.kind, 'human'))),
    );
    let sent = 0;
    for (const { user, channel } of people) {
      const due = monthlyReportDue(now, channel.timeZone, channel.digestHour);
      if (!due.due) continue;
      const orgs = await this.db.system((tx) =>
        tx
          .select({ org: organizations, done: sql<boolean>`exists (select 1 from savings_reports r where r.user_id = ${user.id} and r.org_id = ${organizations.id} and r.period = ${due.period})` })
          .from(memberships)
          .innerJoin(organizations, eq(organizations.id, memberships.orgId))
          .where(
            and(
              eq(memberships.userId, user.id),
              eq(organizations.isActive, true),
              sql`exists (select 1 from subscriptions s where s.org_id = ${organizations.id} and s.status in ('free','trialing','active','past_due'))`,
            ),
          ),
      );
      for (const { org, done } of orgs) {
        if (done) continue;
        try {
          const r = await this.reportFor(org.id, user.id, due, now);
          const id = await this.db.system(async (tx) => {
            const [claim] = await tx
              .insert(savingsReports)
              .values({ userId: user.id, orgId: org.id, period: due.period, saved: r?.totals.saved ?? '0', inProgress: r?.totals.inProgress ?? '0' })
              .onConflictDoNothing()
              .returning();
            if (!claim || !r || savingsNothingToReport(r.totals)) return null;
            const l = langOf(user.locale);
            const content = this.render(r, { lang: l, orgName: l === 'ar' ? (org.nameAr ?? org.name) : org.name, period: due.period });
            const msgId = await this.channels.queue(tx, { orgId: org.id, userId: user.id, to: channel.address, kind: 'monthly_savings', content });
            await tx.update(savingsReports).set({ outboundMessageId: msgId }).where(eq(savingsReports.id, claim.id));
            return msgId;
          });
          if (id) sent++;
        } catch (err) {
          this.logger.error(`monthly savings ${user.id}/${org.id}: ${(err as Error).message}`);
        }
      }
    }
    return sent;
  }

  /** Last month's report for the signed-in person in the current org; optionally sent to their WhatsApp now. */
  async preview(a: AccessContext, send: boolean, now = new Date()) {
    const channel = (await this.channels.myChannel(a.userId)).linked;
    const [org] = await this.db.system((tx) => tx.select().from(organizations).where(eq(organizations.id, a.orgId)));
    const [user] = await this.db.system((tx) => tx.select({ locale: users.locale }).from(users).where(eq(users.id, a.userId)));
    const tz = channel?.timeZone ?? 'Asia/Riyadh';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const period = monthRange(today, -1);
    const r = await this.savings.report(a, period, now);
    const l = langOf(user?.locale);
    const content = this.render(r, { lang: l, orgName: l === 'ar' ? (org!.nameAr ?? org!.name) : org!.name, period: period.from.slice(0, 7) });
    let queued = false;
    if (send) {
      if (!channel) throw new BadRequestException('Link your WhatsApp first');
      const msgId = await this.db.system((tx) => this.channels.queue(tx, { orgId: a.orgId, userId: a.userId, to: channel.address, kind: 'monthly_savings', content }));
      await this.channels.deliver([msgId]);
      queued = true;
    }
    return { period, empty: savingsNothingToReport(r.totals), text: content.text, queued };
  }
}
