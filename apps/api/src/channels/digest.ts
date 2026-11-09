import { Inject, Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, gt, inArray, isNotNull, sql } from 'drizzle-orm';
import {
  agentTasks,
  digestRuns,
  events,
  items,
  memberships,
  organizations,
  purchaseOrders,
  userChannels,
  users,
  type Tx,
} from '@boh/db';
import { digestDue, digestIsEmpty, digestPayload, digestSummary, templateParam, clip, WA_LIMITS, type DigestCounts } from '@boh/domain';
import { APP_CONFIG, type AppConfig } from '../config.js';
import { DbService } from '../common/db.service.js';
import { AccessContext } from '../common/access.js';
import { loadGrants } from '../common/grants.js';
import { ChannelsService } from './channels.service.js';
import type { MessageContent } from './transport.js';

type Lang = 'ar' | 'en';
const lang = (l: string | null | undefined): Lang => (l === 'en' ? 'en' : 'ar');

export interface DigestData {
  counts: DigestCounts;
  waiting: { title: string; titleAr: string }[];
  autoDone: { title: string; titleAr: string }[];
  dueToday: string[];
  late: string[];
  low: { name: string; nameAr: string | null; site: string; siteAr: string | null }[];
  rises: { name: string; nameAr: string | null; pct: number }[];
}

/**
 * The daily digest: what needs the person and what happened, for one org, limited to
 * what their permissions let them see. Sent at their chosen local hour, skipped on
 * days with nothing to say.
 */
@Injectable()
export class DigestService {
  private readonly logger = new Logger('Digest');

  constructor(
    private readonly db: DbService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly channels: ChannelsService,
  ) {}

  /** Collect the digest for one person in one org (access = their grants there). */
  async collect(tx: Tx, access: AccessContext, timeZone: string, now = new Date()): Promise<DigestData> {
    const today = digestDue(now, timeZone, 0).localDate;
    const since = new Date(now.getTime() - 24 * 3600_000);

    const waitingRows = await this.channels.waitingFor(tx, access);
    const waiting = waitingRows.map((r) => ({ title: r.task.title, titleAr: r.task.titleAr }));

    const autoDone = access.can('agent:read')
      ? await tx
          .select({ title: agentTasks.title, titleAr: agentTasks.titleAr })
          .from(agentTasks)
          .where(and(eq(agentTasks.orgId, access.orgId), eq(agentTasks.status, 'executed'), eq(agentTasks.decidedVia, 'auto'), gt(agentTasks.executedAt, since)))
          .orderBy(desc(agentTasks.executedAt))
      : [];

    const siteFilter = (perm: string) => {
      const s = access.sitesFor(perm);
      return s === 'all' ? undefined : s.length ? inArray(purchaseOrders.siteId, s) : sql`false`;
    };
    const canPo = access.sitesFor('po:read');
    const pos =
      canPo === 'all' || canPo.length
        ? await tx
            .select({ number: purchaseOrders.number, status: purchaseOrders.status, deliveryDate: purchaseOrders.deliveryDate })
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.orgId, access.orgId), inArray(purchaseOrders.status, ['approved', 'sent', 'partially_received']), isNotNull(purchaseOrders.deliveryDate), siteFilter('po:read')))
            .orderBy(purchaseOrders.deliveryDate)
        : [];
    const dueToday = pos.filter((p) => p.deliveryDate === today).map((p) => p.number);
    const late = pos.filter((p) => p.status !== 'approved' && p.deliveryDate! < today).map((p) => p.number);
    const approveSites = access.sitesFor('po:approve');
    const [spend] =
      approveSites === 'all' || approveSites.length
        ? await tx
            .select({ n: sql<number>`count(*)::int` })
            .from(purchaseOrders)
            .where(and(eq(purchaseOrders.orgId, access.orgId), eq(purchaseOrders.status, 'pending_approval'), siteFilter('po:approve')))
        : [{ n: 0 }];

    const stockSites = access.sitesFor('stock:read');
    const low =
      stockSites === 'all' || stockSites.length
        ? await tx
            .execute<{ name: string; name_ar: string | null; site: string; site_ar: string | null }>(sql`
              select i.name, i.name_ar, s.name as site, s.name_ar as site_ar
              from item_site_settings iss
              join items i on i.id = iss.item_id and i.is_active
              join sites s on s.id = iss.site_id and s.is_active
              join stock_balances sb on sb.item_id = iss.item_id and sb.site_id = iss.site_id
              where iss.org_id = ${access.orgId} and iss.is_stocked and iss.par_level is not null
                and sb.qty_on_hand <= coalesce(iss.reorder_point, iss.par_level)
                ${stockSites === 'all' ? sql`` : sql`and iss.site_id in (${sql.join(stockSites.map((id) => sql`${id}`), sql`, `)})`}
              order by s.name, i.name`)
            .then((r: any) => (r.rows ?? r).map((x: any) => ({ name: x.name, nameAr: x.name_ar, site: x.site, siteAr: x.site_ar })))
        : [];

    const rises = access.can('price:read')
      ? await tx
          .select({ name: items.name, nameAr: items.nameAr, price: sql<string>`${events.payload}->>'price'`, previous: sql<string>`${events.payload}->>'previousPrice'` })
          .from(events)
          .innerJoin(items, sql`${items.id}::text = ${events.payload}->>'itemId'`)
          .where(
            and(
              eq(events.orgId, access.orgId),
              eq(events.type, 'price.changed'),
              gt(events.occurredAt, since),
              sql`(${events.payload}->>'previousPrice') is not null and (${events.payload}->>'price')::numeric > (${events.payload}->>'previousPrice')::numeric`,
            ),
          )
          .orderBy(desc(events.id))
          .then((rows) => rows.map((r) => ({ name: r.name, nameAr: r.nameAr, pct: ((Number(r.price) - Number(r.previous)) / Number(r.previous)) * 100 })))
      : [];

    return {
      counts: {
        waiting: waiting.length,
        autoDone: autoDone.length,
        pendingSpend: spend?.n ?? 0,
        dueToday: dueToday.length,
        late: late.length,
        lowItems: low.length,
        lowSites: new Set(low.map((l: { site: string }) => l.site)).size,
        priceRises: rises.length,
      },
      waiting,
      autoDone,
      dueToday,
      late,
      low,
      rises,
    };
  }

  render(d: DigestData, o: { lang: Lang; orgId: string; orgName: string; timeZone: string; now?: Date }): MessageContent {
    const ar = o.lang === 'ar';
    const c = d.counts;
    const date = (o.now ?? new Date()).toLocaleDateString(ar ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: o.timeZone });
    const pick = (x: { title: string; titleAr: string }) => (ar ? x.titleAr : x.title);
    const more = (n: number, shown: number) => (n > shown ? [ar ? `• و${n - shown} أخرى` : `• and ${n - shown} more`] : []);
    const list = (xs: string[], max = 3) => xs.slice(0, max).join(ar ? '، ' : ', ') + (xs.length > max ? '…' : '');
    const out: string[] = [`☀️ *${o.orgName}* · ${date}`];

    if (c.waiting) {
      out.push('', ar ? `*بانتظار قرارك (${c.waiting})*` : `*Waiting for your decision (${c.waiting})*`, ...d.waiting.slice(0, 3).map((t) => `• ${pick(t)}`), ...more(c.waiting, 3));
    }
    if (c.autoDone) {
      out.push('', ar ? `*نفّذها وكلاؤك خلال 24 ساعة (${c.autoDone})*` : `*Done by your agents in the last 24 hours (${c.autoDone})*`, ...d.autoDone.slice(0, 3).map((t) => `• ${pick(t)}`), ...more(c.autoDone, 3));
    }
    const orders: string[] = [];
    if (c.pendingSpend) orders.push(ar ? `• ${c.pendingSpend} بانتظار اعتماد الإنفاق` : `• ${c.pendingSpend} waiting for spend approval`);
    if (c.dueToday) orders.push(ar ? `• ${c.dueToday} توريد متوقع اليوم: ${list(d.dueToday)}` : `• ${c.dueToday} ${c.dueToday === 1 ? 'delivery' : 'deliveries'} expected today: ${list(d.dueToday)}`);
    if (c.late) orders.push(ar ? `• ${c.late} متأخر: ${list(d.late)}` : `• ${c.late} late: ${list(d.late)}`);
    if (orders.length) out.push('', ar ? '*الطلبات*' : '*Orders*', ...orders);
    if (c.lowItems) {
      const names = d.low.map((l) => (ar ? (l.nameAr ?? l.name) : l.name));
      out.push(
        '',
        ar
          ? `*المخزون*: ${c.lowItems} صنف منخفض في ${c.lowSites} ${c.lowSites === 1 ? 'فرع' : 'فروع'}: ${list([...new Set(names)], 4)}`
          : `*Stock*: ${c.lowItems} ${c.lowItems === 1 ? 'item' : 'items'} low at ${c.lowSites} ${c.lowSites === 1 ? 'site' : 'sites'}: ${list([...new Set(names)], 4)}`,
      );
    }
    if (c.priceRises) {
      const r = d.rises.map((x) => `${ar ? (x.nameAr ?? x.name) : x.name} +${x.pct.toFixed(1)}%`);
      out.push('', ar ? `*الأسعار*: ${c.priceRises} ارتفاع: ${list(r)}` : `*Prices*: ${c.priceRises} ${c.priceRises === 1 ? 'rise' : 'rises'}: ${list(r)}`);
    }
    out.push('', `${ar ? 'افتح Backhouse' : 'Open Backhouse'}: ${this.config.PUBLIC_WEB_URL.replace(/\/$/, '')}/inbox`);

    const showTitle = ar ? 'اعرض القرارات' : 'Show decisions';
    return {
      lang: o.lang,
      text: clip(out.join('\n'), WA_LIMITS.body),
      buttons: c.waiting ? [{ id: digestPayload(o.orgId), title: showTitle }] : undefined,
      template: {
        name: this.config.WHATSAPP_TEMPLATE_DIGEST,
        bodyParams: [templateParam(o.orgName, 100), templateParam(date, 60), templateParam(digestSummary(c, o.lang), 600)],
        quickReplyPayloads: [digestPayload(o.orgId)],
        urlSuffix: 'inbox',
      },
    };
  }

  /**
   * Worker: send digests that are due. A digest_runs row claims each person/org/day first,
   * so several workers (or restarts) never send twice. Empty days are recorded, not sent.
   */
  async runDue(now = new Date()): Promise<number> {
    const people = await this.db.system((tx) =>
      tx
        .select({ user: users, channel: userChannels })
        .from(userChannels)
        .innerJoin(users, eq(users.id, userChannels.userId))
        .where(and(eq(userChannels.channel, 'whatsapp'), eq(userChannels.digestEnabled, true), eq(users.isActive, true), eq(users.kind, 'human'))),
    );
    let sent = 0;
    for (const { user, channel } of people) {
      const { due, localDate } = digestDue(now, channel.timeZone, channel.digestHour);
      if (!due) continue;
      const orgs = await this.db.system((tx) =>
        tx
          .select({ org: organizations })
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
      for (const { org } of orgs) {
        try {
          const id = await this.db.system(async (tx) => {
            const [claim] = await tx.insert(digestRuns).values({ userId: user.id, orgId: org.id, localDate, counts: {} }).onConflictDoNothing().returning();
            if (!claim) return null;
            const access = new AccessContext(org.id, user.id, await loadGrants(tx, org.id, user.id), 'digest', undefined);
            const data = await this.collect(tx, access, channel.timeZone, now);
            await tx.update(digestRuns).set({ counts: { ...data.counts } }).where(eq(digestRuns.id, claim.id));
            if (digestIsEmpty(data.counts)) return null;
            const l = lang(user.locale);
            const content = this.render(data, { lang: l, orgId: org.id, orgName: l === 'ar' ? (org.nameAr ?? org.name) : org.name, timeZone: channel.timeZone, now });
            const msgId = await this.channels.queue(tx, { orgId: org.id, userId: user.id, to: channel.address, kind: 'digest', content });
            await tx.update(digestRuns).set({ outboundMessageId: msgId }).where(eq(digestRuns.id, claim.id));
            return msgId;
          });
          if (id) sent++;
        } catch (err) {
          this.logger.error(`digest ${user.id}/${org.id}: ${(err as Error).message}`);
        }
      }
    }
    return sent;
  }

  /** Today's digest for the signed-in person in the current org; optionally sent now (not counted as the daily one). */
  async preview(a: AccessContext, send: boolean) {
    const result = await this.db.system(async (tx) => {
      const [user] = await tx.select().from(users).where(eq(users.id, a.userId));
      const [org] = await tx.select().from(organizations).where(eq(organizations.id, a.orgId));
      const [channel] = await tx.select().from(userChannels).where(and(eq(userChannels.userId, a.userId), eq(userChannels.channel, 'whatsapp')));
      const tz = channel?.timeZone ?? 'Asia/Riyadh';
      const data = await this.collect(tx, a, tz);
      const l = lang(user?.locale);
      const content = this.render(data, { lang: l, orgId: a.orgId, orgName: l === 'ar' ? (org?.nameAr ?? org?.name ?? '') : (org?.name ?? ''), timeZone: tz });
      const msgId = send && channel ? await this.channels.queue(tx, { orgId: a.orgId, userId: a.userId, to: channel.address, kind: 'digest', content }) : null;
      return { counts: data.counts, empty: digestIsEmpty(data.counts), text: content.text, summary: content.template!.bodyParams[2], queued: Boolean(msgId), msgId };
    });
    if (result.msgId) await this.channels.deliver([result.msgId]);
    const { msgId: _ignored, ...rest } = result;
    return rest;
  }
}
