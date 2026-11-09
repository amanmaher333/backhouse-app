import { and, eq } from 'drizzle-orm';
import { organizations, sites, stockCounts, type AgentAction } from '@boh/db';
import { Decimal, currencyAr } from '@boh/domain';
import type { TaskText } from './llm.js';
import type { AgentDefinition, RunContext, TaskProposal } from './types.js';

/*
 * Cost Controller: a weekly food cost report per site.
 *
 * Deterministic part (code): the theoretical vs actual report for the last completed week
 * (see docs/food-cost.md), the biggest losses, sales without recipes, menu items over their
 * food cost target, and gaps in the data (missing counts, unlinked branches).
 * Language part (Claude or templates): a bilingual headline and summary of what matters.
 *
 * Runs on the daily scan; each site gets one report per week (subject weekly:<site>:<week end>),
 * so running again only refreshes it. Older weeks' unread reports expire.
 */

const DAY = 86400_000;
const localDate = (t: Date, tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(t);
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();

/** The last completed week ending on `weekEndsOn` (0 = Sunday … 6 = Saturday), in the site's time zone. */
export function lastCompletedWeek(now: Date, tz: string, weekEndsOn: number) {
  let end = addDays(localDate(now, tz), -1);
  while (weekday(end) !== weekEndsOn) end = addDays(end, -1);
  return { from: addDays(end, -6), to: end };
}

const money = (v: string | number | Decimal, cur: string) => `${cur} ${new Decimal(v).toFixed(2)}`;
const moneyAr = (v: string | number | Decimal, cur: string) => `${new Decimal(v).toFixed(2)} ${currencyAr(cur)}`;
const qty = (v: string, baseUnit: string) => {
  const n = new Decimal(v);
  if (baseUnit === 'g') return n.abs().gte(1000) ? `${n.div(1000).toDecimalPlaces(2).toString()} kg` : `${n.toDecimalPlaces(0).toString()} g`;
  if (baseUnit === 'ml') return n.abs().gte(1000) ? `${n.div(1000).toDecimalPlaces(2).toString()} L` : `${n.toDecimalPlaces(0).toString()} ml`;
  return `${n.toDecimalPlaces(1).toString()} each`;
};
const qtyAr = (v: string, baseUnit: string) =>
  qty(v, baseUnit).replace(' kg', ' كجم').replace(' g', ' غ').replace(' L', ' لتر').replace(' ml', ' مل').replace(' each', ' حبة');

async function reportFor(ctx: RunContext, site: typeof sites.$inferSelect, currency: string): Promise<TaskProposal | null> {
  const { tx, access, settings, services } = ctx;
  const weekEndsOn = Number(settings.weekEndsOn ?? 6);
  const gapAlert = Number(settings.gapAlertPts ?? 3);
  const week = lastCompletedWeek(new Date(), site.timezone, weekEndsOn);
  const r = await services.foodCost.reportInTx(tx, access, { siteId: site.id, from: week.from, to: week.to });
  // Nothing to compare without sales from a linked POS branch.
  if (!r.pos.connected || r.pos.linkedLocations === 0 || !r.totals || new Decimal(r.totals.netSales).lte(0)) return null;

  const t = r.totals;
  const losses = r.rows
    .filter((x) => x.varianceValue && new Decimal(x.varianceValue).gt(0))
    .slice(0, 5)
    .map((x) => ({ itemId: x.itemId, name: x.name, nameAr: x.nameAr, extra: qty(x.variance, x.baseUnit), extraAr: qtyAr(x.variance, x.baseUnit), value: x.varianceValue! }));
  const withoutRecipeNet = r.withoutRecipe.reduce((s, w) => s.plus(w.net ?? 0), new Decimal(0));
  const withoutRecipeShare = new Decimal(t.netSales).gt(0) ? withoutRecipeNet.div(t.netSales).mul(100).toFixed(1) : '0.0';
  const recipes = await services.recipes.listInTx(tx, access, { kind: 'menu', basis: 'average' });
  const overTarget = recipes
    .filter((x) => x.overTarget && x.foodCostPct)
    .sort((a, b) => Number(b.foodCostPct) - Number(a.foodCostPct))
    .slice(0, 5)
    .map((x) => ({ recipeId: x.id, name: x.name, nameAr: x.nameAr, foodCostPct: x.foodCostPct, target: x.targetCostPct ? new Decimal(x.targetCostPct).toFixed(0) : null }));
  const gaps = { countAtStart: Boolean(r.counts.start), countAtEnd: Boolean(r.counts.end), unlinkedBranches: r.pos.unlinkedLocations, itemsWithoutCost: r.noCost };
  const gap = t.gapPct !== null ? Number(t.gapPct) : null;
  const priority = (gap !== null && gap >= gapAlert) || Number(withoutRecipeShare) >= 20 ? 1 : 2;

  const evidence = {
    kind: 'weekly_food_cost',
    currency,
    site: { id: site.id, name: site.name, nameAr: site.nameAr },
    period: week,
    totals: t,
    topLosses: losses,
    withoutRecipe: { count: r.withoutRecipe.length, netSales: withoutRecipeNet.toFixed(2), sharePct: withoutRecipeShare, products: r.withoutRecipe.slice(0, 5).map((w) => ({ name: w.name, qty: w.qty, net: w.net })) },
    overTarget,
    gaps,
    gapAlertPts: gapAlert,
  };

  const template = (): TaskText => {
    const siteEn = site.name;
    const siteAr = site.nameAr ?? site.name;
    const pct = (v: string | null) => (v === null ? '–' : `${v}%`);
    const title = t.actualPct && t.theoreticalPct ? `Food cost last week at ${siteEn}: ${t.actualPct}% vs ${t.theoreticalPct}% from recipes` : `Food cost last week at ${siteEn}`;
    const titleAr = t.actualPct && t.theoreticalPct ? `تكلفة الطعام الأسبوع الماضي في ${siteAr}: ${t.actualPct}% مقابل ${t.theoreticalPct}% حسب الوصفات` : `تكلفة الطعام الأسبوع الماضي في ${siteAr}`;
    const en: string[] = [`Net sales ${money(t.netSales, currency)}; actual food cost ${pct(t.actualPct)} against ${pct(t.theoreticalPct)} from recipes and recorded waste${gap !== null ? `, a gap of ${t.gapPct} points (about ${money(t.varianceCost, currency)} unexplained)` : ''}.`];
    const ar: string[] = [`صافي المبيعات ${moneyAr(t.netSales, currency)}؛ تكلفة الطعام الفعلية ${pct(t.actualPct)} مقابل ${pct(t.theoreticalPct)} حسب الوصفات والهدر المسجل${gap !== null ? `، بفجوة ${t.gapPct} نقطة (نحو ${moneyAr(t.varianceCost, currency)} غير مفسَّر)` : ''}.`];
    if (losses.length) {
      en.push(`Biggest losses: ${losses.slice(0, 3).map((l) => `${l.name} (+${l.extra}, ${money(l.value, currency)})`).join(', ')}.`);
      ar.push(`أكبر الخسائر: ${losses.slice(0, 3).map((l) => `${l.nameAr ?? l.name} (+${l.extraAr}، ${moneyAr(l.value, currency)})`).join('، ')}.`);
    }
    if (r.withoutRecipe.length) {
      en.push(`${r.withoutRecipe.length} products sold without a recipe (${withoutRecipeShare}% of sales) aren't covered; add their recipes.`);
      ar.push(`${r.withoutRecipe.length} منتجات بيعت بدون وصفة (${withoutRecipeShare}% من المبيعات) غير مشمولة؛ أضف وصفاتها.`);
    }
    if (!gaps.countAtStart || !gaps.countAtEnd) {
      en.push('Stock wasn’t counted at both ends of the week, so “actual” may be off; count at close on the last day of each week.');
      ar.push('لم يُجرد المخزون في بداية الأسبوع ونهايته، لذا قد تكون «الفعلية» غير دقيقة؛ اجرد عند الإغلاق في آخر يوم من كل أسبوع.');
    }
    if (overTarget.length) {
      en.push(`Over their food cost target: ${overTarget.slice(0, 3).map((o) => `${o.name} ${o.foodCostPct}%${o.target ? ` (target ${o.target}%)` : ''}`).join(', ')}.`);
      ar.push(`فوق نسبة التكلفة المستهدفة: ${overTarget.slice(0, 3).map((o) => `${o.nameAr ?? o.name} ${o.foodCostPct}%${o.target ? ` (المستهدف ${o.target}%)` : ''}`).join('، ')}.`);
    }
    return { title, title_ar: titleAr, summary: en.join(' '), summary_ar: ar.join(' '), message: '', message_ar: '' };
  };

  const written = await ctx.llm.write(
    'Write the weekly food cost report for one restaurant site, for its manager. title: the headline (actual vs theoretical food cost %, or the main problem if data is missing). ' +
      'summary: 3-4 plain sentences in this order: net sales and the gap between actual and theoretical food cost with its value; the two or three biggest losses with their extra quantity and value; ' +
      'sales without recipes and missing stock counts if any (these make the numbers less reliable); one concrete thing to check this week. message and message_ar: empty strings.',
    evidence,
    template,
  );
  ctx.usage.model = written.model ?? ctx.usage.model;
  ctx.usage.inputTokens += written.inputTokens;
  ctx.usage.outputTokens += written.outputTokens;
  ctx.usage.costUsd += written.costUsd;

  const actions: Omit<AgentAction, 'autonomy'>[] = [];
  if (!gaps.countAtEnd) {
    const [open] = await tx.select({ id: stockCounts.id }).from(stockCounts).where(and(eq(stockCounts.siteId, site.id), eq(stockCounts.status, 'open'))).limit(1);
    if (!open) actions.push({ id: 'start_count', type: 'start_count', label: `Start a stock count at ${site.name}`, labelAr: `ابدأ جرد المخزون في ${site.nameAr ?? site.name}`, params: { siteId: site.id } });
  }

  return {
    kind: 'weekly_food_cost',
    subjectKey: `weekly:${site.id}:${week.to}`,
    priority,
    title: written.text.title,
    titleAr: written.text.title_ar,
    summary: written.text.summary,
    summaryAr: written.text.summary_ar,
    evidence,
    actions,
    writtenBy: written.writtenBy,
  };
}

export const costController: AgentDefinition = {
  kind: 'cost_controller',
  name: 'Cost Controller',
  nameAr: 'مراقب التكاليف',
  description: 'Every week, compares what each site used with what its sales and recipes say it should have used, and tells you where food cost leaks.',
  descriptionAr: 'كل أسبوع، يقارن ما استخدمه كل فرع بما يفترض استخدامه حسب المبيعات والوصفات، ويخبرك أين تتسرب تكلفة الطعام.',
  roleKey: 'agent_cost_controller',
  subscribes: [],
  actionTypes: [{ type: 'start_count', label: 'Start stock counts', labelAr: 'بدء جرد المخزون', allowed: ['suggest', 'approve', 'auto'], default: 'approve', requires: 'stock:manage' }],
  defaultSettings: { weekEndsOn: 6, gapAlertPts: 3 },

  async handleEvents() {
    return [];
  },

  async scan(ctx) {
    const [org] = await ctx.tx.select({ currency: organizations.defaultCurrency }).from(organizations);
    const all = await ctx.tx.select().from(sites).where(eq(sites.isActive, true));
    const proposals: TaskProposal[] = [];
    for (const s of all) {
      if (!ctx.access.can('stock:read', s.id)) continue;
      const p = await reportFor(ctx, s, org?.currency ?? 'SAR');
      if (p) proposals.push(p);
    }
    // A new week's report replaces last week's unread one.
    return { proposals, expirePrefixes: ['weekly:'] };
  },

  async guardrail(action, ctx) {
    if (action.type !== 'start_count') return `Unknown action ${action.type}`;
    const siteId = String(action.params.siteId ?? '');
    const [site] = await ctx.tx.select({ id: sites.id }).from(sites).where(eq(sites.id, siteId));
    if (!site) return 'Site not found';
    const [open] = await ctx.tx.select({ ref: stockCounts.ref }).from(stockCounts).where(and(eq(stockCounts.siteId, siteId), eq(stockCounts.status, 'open'))).limit(1);
    return open ? `A count is already open at this site (${open.ref})` : null;
  },

  async execute(action, ctx) {
    const siteId = String(action.params.siteId);
    const c = await ctx.services.stockCounts.createInTx(ctx.tx, ctx.access, siteId, { scope: 'full', blind: true, note: 'Started from the Cost Controller weekly report' }, 'agent');
    return { countId: c.id, ref: c.ref };
  },
};
