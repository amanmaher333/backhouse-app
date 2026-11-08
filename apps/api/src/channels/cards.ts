import { approvalPayload, clip, templateParam, WA_LIMITS } from '@boh/domain';
import type { AgentAction } from '@boh/db';
import type { MessageContent } from './transport.js';

/*
 * What people see on WhatsApp. Two forms of every approval card:
 * - interactive (reply buttons), allowed for 24 hours after the person last wrote to BOH;
 * - an approved template (quick-reply buttons + link), for any other time.
 * Template text must match what is registered with Meta: see docs/whatsapp-templates.md.
 */

type Lang = 'ar' | 'en';

export interface CardTask {
  id: string;
  title: string;
  titleAr: string;
  summary: string;
  summaryAr: string;
  evidence: Record<string, unknown>;
}

export interface CardInput {
  lang: Lang;
  task: CardTask;
  action: AgentAction;
  agentName: string;
  agentNameAr: string;
  orgName: string;
  promptId: string;
  canApprove: boolean;
  /** Largest value approvable on WhatsApp, for the "open BOH" note. */
  cap: number;
  webUrl: string;
  templates: { approval: string; notice: string };
}

const fmt = (n: number) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n: number, lang: Lang) => (lang === 'ar' ? `${fmt(n)} ر.س` : `SAR ${fmt(n)}`);

/** A task's money value for the WhatsApp cap: the order total incl. VAT when there is one. */
export function taskValue(task: { evidence: Record<string, unknown> }, action: AgentAction): number {
  const raw = task.evidence.total ?? (action.params as Record<string, unknown>)?.total ?? 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

export function taskLink(webUrl: string, taskId: string) {
  return `${webUrl.replace(/\/$/, '')}/inbox?task=${taskId}`;
}

interface EvidenceLine {
  item?: string;
  itemAr?: string;
  qty?: number;
  pack?: string;
  packAr?: string;
  lineTotal?: string;
}

/** Up to five order lines as bullet points, when the evidence has them. */
function lineBullets(evidence: Record<string, unknown>, lang: Lang): string[] {
  const lines = Array.isArray(evidence.lines) ? (evidence.lines as EvidenceLine[]) : [];
  const out = lines.slice(0, 5).map((l) => {
    const name = lang === 'ar' ? (l.itemAr ?? l.item) : l.item;
    const pack = lang === 'ar' ? (l.packAr ?? l.pack) : l.pack;
    const total = l.lineTotal !== undefined ? ` = ${money(Number(l.lineTotal), lang)}` : '';
    return `• ${name}: ${l.qty} × ${pack}${total}`;
  });
  if (lines.length > 5) out.push(lang === 'ar' ? `• و${lines.length - 5} أصناف أخرى` : `• and ${lines.length - 5} more`);
  return out;
}

function facts(evidence: Record<string, unknown>, lang: Lang): string[] {
  const out: string[] = [];
  if (evidence.total !== undefined) out.push(lang === 'ar' ? `الإجمالي: ${money(Number(evidence.total), lang)} شامل الضريبة` : `Total: ${money(Number(evidence.total), lang)} incl. VAT`);
  if (typeof evidence.deliveryDate === 'string') out.push(lang === 'ar' ? `التوصيل: ⁦${evidence.deliveryDate}⁩` : `Delivery: ${evidence.deliveryDate}`);
  return out;
}

export function approvalCard(i: CardInput): MessageContent {
  const ar = i.lang === 'ar';
  const agent = ar ? i.agentNameAr : i.agentName;
  const title = ar ? i.task.titleAr : i.task.title;
  const summary = ar ? i.task.summaryAr : i.task.summary;
  const actionLabel = ar ? i.action.labelAr : i.action.label;
  const link = taskLink(i.webUrl, i.task.id);
  const bullets = lineBullets(i.task.evidence, i.lang);
  const f = facts(i.task.evidence, i.lang);

  const capNote = ar
    ? `هذا أعلى من حد الاعتماد عبر واتساب (${money(i.cap, i.lang)}). اعتمده من BOH.`
    : `This is above the ${money(i.cap, i.lang)} limit for approving on WhatsApp. Approve it in BOH.`;
  const tail = [i.canApprove ? (ar ? `✅ اعتماد يعني: ${actionLabel}` : `✅ Approve means: ${actionLabel}`) : `⚠️ ${capNote}`, link];

  const head = ar ? `🤖 *${agent}* يحتاج قرارك` : `🤖 *${agent}* needs your decision`;
  // Keep the head, the decision line and the link; trim the middle to fit WhatsApp's 1024-character body.
  const fixed = [head, `*${title}*`, '', ...tail].join('\n').length + 4;
  const middle = clip([summary, bullets.join('\n'), f.join('\n')].filter(Boolean).join('\n\n'), Math.max(80, WA_LIMITS.body - fixed));
  const text = [head, '', `*${title}*`, middle, '', ...tail].join('\n');

  const buttons = [
    ...(i.canApprove ? [{ id: approvalPayload(i.promptId, 'approve'), title: ar ? 'اعتماد' : 'Approve' }] : []),
    { id: approvalPayload(i.promptId, 'reject'), title: ar ? 'رفض' : 'Reject' },
  ];

  // Template parameters: {{1}} agent, {{2}} title, {{3}} details. The URL button's suffix is the task id.
  const details = [summary, ...f].join(' · ');
  return {
    lang: i.lang,
    text,
    footer: clip(`BOH · ${i.orgName}`, 60),
    buttons,
    template: {
      name: i.canApprove ? i.templates.approval : i.templates.notice,
      bodyParams: [templateParam(agent, 60), templateParam(title, 200), templateParam(details, 600)],
      quickReplyPayloads: buttons.map((b) => b.id),
      urlSuffix: i.task.id,
    },
  };
}

/** Plain replies (always inside the 24-hour window: the person just wrote to us). */
export const replies = {
  linked: (lang: Lang, name: string) =>
    lang === 'ar'
      ? `✅ تم ربط واتساب بحساب ${name} في BOH.\nستصلك هنا طلبات الاعتماد من وكلائك. أرسل "إيقاف" لإيقافها و"تشغيل" لإعادتها.`
      : `✅ WhatsApp is now linked to ${name}'s BOH account.\nApproval requests from your agents will arrive here. Send "STOP" to pause them and "START" to resume.`,
  badCode: (lang: Lang) =>
    lang === 'ar' ? 'رمز الربط غير صحيح أو منتهي. أنشئ رمزًا جديدًا من الإعدادات ← واتساب في BOH.' : 'That link code is wrong or has expired. Create a new one in BOH under Settings → WhatsApp.',
  numberTaken: (lang: Lang) =>
    lang === 'ar' ? 'هذا الرقم مربوط بحساب آخر في BOH. افصله من ذلك الحساب أولًا.' : 'This number is linked to another BOH account. Unlink it there first.',
  unknown: () =>
    'هذا الرقم غير مربوط بحساب في BOH. للربط: الإعدادات ← واتساب.\nThis number is not linked to a BOH account. To link it, go to Settings → WhatsApp in BOH.',
  help: (lang: Lang, enabled: boolean) =>
    lang === 'ar'
      ? `هذا رقم BOH. نرسل هنا طلبات الاعتماد من وكلائك، وتردّ عليها بالأزرار.\nالتنبيهات ${enabled ? 'مفعّلة' : 'موقوفة'}. أرسل "إيقاف" أو "تشغيل".`
      : `This is BOH. Approval requests from your agents arrive here; answer them with the buttons.\nAlerts are ${enabled ? 'on' : 'paused'}. Send "STOP" or "START".`,
  paused: (lang: Lang) => (lang === 'ar' ? 'تم إيقاف طلبات الاعتماد على واتساب. أرسل "تشغيل" لإعادتها.' : 'WhatsApp approval requests are paused. Send "START" to resume.'),
  resumed: (lang: Lang) => (lang === 'ar' ? 'تمت إعادة تشغيل طلبات الاعتماد على واتساب.' : 'WhatsApp approval requests are back on.'),
  notYours: (lang: Lang) => (lang === 'ar' ? 'هذا الزر ليس لهذا الرقم.' : 'That button is not for this number.'),
  expired: (lang: Lang, link: string) => (lang === 'ar' ? `انتهت صلاحية هذا الطلب على واتساب. افتحه في BOH:\n${link}` : `This request has expired on WhatsApp. Open it in BOH:\n${link}`),
  overCap: (lang: Lang, link: string) =>
    lang === 'ar' ? `هذا الطلب أعلى من حد الاعتماد عبر واتساب. اعتمده من BOH:\n${link}` : `This is above the limit for approving on WhatsApp. Approve it in BOH:\n${link}`,
  alreadyDecided: (lang: Lang, title: string, status: string, via: string | null) => {
    const st: Record<string, [string, string]> = {
      executed: ['done', 'تم تنفيذه'],
      failed: ['blocked', 'تعذّر تنفيذه'],
      rejected: ['rejected', 'تم رفضه'],
      dismissed: ['dismissed', 'تم تجاهله'],
      expired: ['no longer needed', 'لم يعد مطلوبًا'],
      approved: ['approved', 'تم اعتماده'],
    };
    const [en, arS] = st[status] ?? [status, status];
    const where = via === 'whatsapp' ? (lang === 'ar' ? ' عبر واتساب' : ' on WhatsApp') : via === 'web' ? (lang === 'ar' ? ' من BOH' : ' in BOH') : '';
    return lang === 'ar' ? `ℹ️ «${title}» ${arS}${where} مسبقًا.` : `ℹ️ "${title}" was already ${en}${where}.`;
  },
  done: (lang: Lang, title: string, result: Record<string, unknown> | null) => {
    const po = result?.number ? String(result.number) : null;
    const pending = result?.status === 'pending_approval';
    if (po) {
      return lang === 'ar'
        ? `✅ تم: أُنشئ الطلب ${po}.${pending ? ' ينتظر اعتماد صاحب صلاحية الإنفاق.' : ''}\n${title}`
        : `✅ Done: order ${po} created.${pending ? ' It is waiting for spend approval.' : ''}\n${title}`;
    }
    if (result?.prepared) return lang === 'ar' ? `✅ تم تجهيز الرسالة للمورد. أرسلها من BOH.\n${title}` : `✅ The supplier message is ready. Send it from BOH.\n${title}`;
    return lang === 'ar' ? `✅ تم: ${title}` : `✅ Done: ${title}`;
  },
  blocked: (lang: Lang, title: string, reason: string) => (lang === 'ar' ? `⚠️ لم يُنفَّذ «${title}»: ${reason}` : `⚠️ Not done: "${title}": ${reason}`),
  rejected: (lang: Lang, title: string) => (lang === 'ar' ? `❌ تم الرفض: ${title}` : `❌ Rejected: ${title}`),
  nothingWaiting: (lang: Lang) => (lang === 'ar' ? '👍 لا شيء بانتظار قرارك الآن.' : '👍 Nothing is waiting for your decision right now.'),
  refused: (lang: Lang, reason: string) => (lang === 'ar' ? `⚠️ تعذّر ذلك: ${reason}` : `⚠️ Could not do that: ${reason}`),
};
