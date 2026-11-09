'use client';

import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { arCatalog, enCatalog } from './i18n-catalog';
import { arAgents, enAgents } from './i18n-agents';
import { arProcurement, enProcurement } from './i18n-procurement';
import { arChannels, enChannels } from './i18n-channels';
import { arBilling, enBilling } from './i18n-billing';
import { arInvoices, enInvoices } from './i18n-invoices';
import { arSales, enSales } from './i18n-sales';
import { arCounts, enCounts } from './i18n-counts';
import { arWaste, enWaste } from './i18n-waste';
import { arPos, enPos } from './i18n-pos';
import { arRecipes, enRecipes } from './i18n-recipes';
import { arFoodCost, enFoodCost } from './i18n-foodcost';
import { arSavings, enSavings } from './i18n-savings';

export type Lang = 'en' | 'ar';

const en = {
  ...enCatalog,
  ...enAgents,
  ...enProcurement,
  ...enChannels,
  ...enBilling,
  ...enInvoices,
  ...enSales,
  ...enCounts,
  ...enWaste,
  ...enPos,
  ...enRecipes,
  ...enFoodCost,
  ...enSavings,
  appName: 'Backhouse',
  appSub: 'AI back office',
  // nav
  navMain: 'Workspace',
  navAdmin: 'Admin',
  overview: 'Overview',
  sites: 'Sites',
  members: 'Members',
  roles: 'Roles',
  audit: 'Audit log',
  settings: 'Settings',
  insights: 'Ask Backhouse',
  more: 'More',
  organization: 'Organisation',
  signOut: 'Sign out',
  collapse: 'Collapse sidebar',
  menu: 'Menu',
  // top bar
  online: 'Online',
  offline: 'Offline',
  theme: 'Switch theme',
  language: 'العربية',
  installApp: 'Install app',
  // auth
  heroLabel: 'Saudi Arabia and the Gulf · ZATCA-ready',
  country: 'Country',
  countryHint: 'Where the business is registered: sets currency, VAT and number formats',
  heroTitle: 'Run every kitchen from one place',
  heroLead: 'Orders, stock, recipes and food cost for every branch, plus a supplier network that gets better as you grow.',
  signIn: 'Sign in',
  signInTitle: 'Welcome back',
  createAccount: 'Create account',
  createTitle: 'Set up your organisation',
  email: 'Email',
  password: 'Password',
  passwordHint: 'At least 10 characters',
  fullName: 'Full name',
  phone: 'Mobile (optional)',
  orgName: 'Organisation name',
  orgNameAr: 'Organisation name in Arabic',
  orgType: 'You are a',
  restaurantGroup: 'Restaurant group',
  supplier: 'Supplier',
  legalName: 'Legal entity name',
  vatNumber: 'VAT number',
  vatHint: '15 digits, starts and ends with 3',
  crNumber: 'CR number',
  crHint: '10 digits',
  noAccount: 'New to Backhouse?',
  haveAccount: 'Already have an account?',
  acceptInvite: 'Join organisation',
  acceptInviteTitle: 'You have been invited',
  acceptInviteHint: 'If you already have an account, enter its password.',
  pickOrg: 'Choose an organisation',
  // overview
  overviewSub: 'Your organisation at a glance',
  gettingStarted: 'Getting started',
  stepEntity: 'Add your legal entity with VAT and CR numbers',
  stepSite: 'Add your first branch',
  stepLocations: 'Add storage locations to each branch',
  stepTeam: 'Invite your team',
  done: 'Done',
  todo: 'To do',
  legalEntities: 'Legal entities',
  storageLocations: 'Storage locations',
  comingNext: 'Coming next',
  comingNextBody: 'Purchase orders, approvals and receiving deliveries arrive in phase 2.',
  // sites
  sitesSub: 'Branches, central kitchens and warehouses',
  addSite: 'Add site',
  siteName: 'Site name',
  siteNameAr: 'Site name in Arabic',
  siteCode: 'Code',
  siteType: 'Type',
  restaurant: 'Restaurant',
  central_kitchen: 'Central kitchen',
  warehouse: 'Warehouse',
  legalEntity: 'Legal entity',
  city: 'City',
  district: 'District',
  active: 'Active',
  inactive: 'Inactive',
  noSites: 'No sites yet',
  noSitesBody: 'Add your first branch to start tracking stock.',
  locations: 'Locations',
  addLocation: 'Add location',
  locationName: 'Location name',
  locationNameAr: 'Location name in Arabic',
  noLocations: 'No storage locations yet',
  noLocationsBody: 'For example walk-in chiller, freezer, dry store, bar.',
  timezone: 'Time zone',
  details: 'Details',
  // members
  membersSub: 'People and what they can do',
  invite: 'Invite',
  inviteTitle: 'Invite a team member',
  role: 'Role',
  allSites: 'All sites',
  limitSites: 'Limit to sites',
  inviteLink: 'Invite link',
  inviteLinkHint: 'Share this link. It expires in 7 days. Email and WhatsApp delivery come later.',
  copy: 'Copy',
  copied: 'Copied',
  pendingInvites: 'Pending invitations',
  revoke: 'Revoke',
  remove: 'Remove',
  confirm: 'Tap again to confirm',
  expires: 'Expires',
  scopeOrg: 'Whole organisation',
  scopeSite: 'Selected sites',
  changeRole: 'Change role',
  // roles
  rolesSub: 'Built-in and custom roles',
  addRole: 'Add role',
  roleKey: 'Key',
  roleName: 'Role name',
  roleNameAr: 'Role name in Arabic',
  scope: 'Scope',
  permissions: 'Permissions',
  system: 'Built in',
  custom: 'Custom',
  // audit
  auditSub: 'Every change, who made it and when',
  when: 'When',
  who: 'Who',
  action: 'Action',
  entity: 'Record',
  changes: 'Changes',
  before: 'Before',
  after: 'After',
  loadMore: 'Load more',
  noEvents: 'No events yet',
  // settings
  settingsSub: 'Organisation and legal entities',
  save: 'Save',
  saved: 'Saved',
  cancel: 'Cancel',
  close: 'Close',
  add: 'Add',
  edit: 'Edit',
  addEntity: 'Add legal entity',
  defaultLanguage: 'Default language',
  vatRegistered: 'VAT registered',
  // insights
  insightsTitle: 'Ask about your food cost',
  insightsLead: 'The Backhouse agent will explain costs, waste and price changes in plain words, and suggest what to do. It connects to your data once purchasing and stock are live.',
  insightsSoon: 'Preview. The agent goes live in phase 8; answers below use sample data.',
  sampleData: 'Sample data',
  askPlaceholder: 'Ask anything about your kitchens',
  ask: 'Ask',
  voice: 'Voice',
  q1: 'Why did food cost go up this week?',
  q2: 'Which supplier prices changed?',
  q3: 'Where are we wasting the most?',
  q4: 'What should I order for tomorrow?',
  // generic
  loading: 'Loading',
  error: 'Something went wrong',
  errorBody: 'This page hit a problem. We’ve been told about it. Try again, or go back to the inbox.',
  tryAgain: 'Try again',
  backToInbox: 'Back to the inbox',
  required: 'Required',
  optional: 'optional',
};

type Dict = typeof en;

const ar: Dict = {
  ...arCatalog,
  ...arAgents,
  ...arProcurement,
  ...arChannels,
  ...arBilling,
  ...arInvoices,
  ...arSales,
  ...arCounts,
  ...arWaste,
  ...arPos,
  ...arRecipes,
  ...arFoodCost,
  ...arSavings,
  appName: 'Backhouse',
  appSub: 'المكتب الخلفي الذكي',
  navMain: 'مساحة العمل',
  navAdmin: 'الإدارة',
  overview: 'نظرة عامة',
  sites: 'الفروع',
  members: 'الأعضاء',
  roles: 'الأدوار',
  audit: 'سجل التدقيق',
  settings: 'الإعدادات',
  insights: 'اسأل Backhouse',
  more: 'المزيد',
  organization: 'المؤسسة',
  signOut: 'تسجيل الخروج',
  collapse: 'طي القائمة',
  menu: 'القائمة',
  online: 'متصل',
  offline: 'غير متصل',
  theme: 'تبديل المظهر',
  language: 'English',
  installApp: 'تثبيت التطبيق',
  heroLabel: 'السعودية والخليج · جاهز لفاتورة',
  country: 'الدولة',
  countryHint: 'حيث سُجلت المنشأة: تحدد العملة والضريبة وصيغ الأرقام',
  heroTitle: 'أدِر كل مطابخك من مكان واحد',
  heroLead: 'الطلبات والمخزون والوصفات وتكلفة الطعام لكل فرع، مع شبكة موردين تتحسن كلما كبرت.',
  signIn: 'تسجيل الدخول',
  signInTitle: 'مرحبًا بعودتك',
  createAccount: 'إنشاء حساب',
  createTitle: 'أنشئ مؤسستك',
  email: 'البريد الإلكتروني',
  password: 'كلمة المرور',
  passwordHint: '10 أحرف على الأقل',
  fullName: 'الاسم الكامل',
  phone: 'الجوال (اختياري)',
  orgName: 'اسم المؤسسة',
  orgNameAr: 'اسم المؤسسة بالعربية',
  orgType: 'نوع النشاط',
  restaurantGroup: 'مجموعة مطاعم',
  supplier: 'مورّد',
  legalName: 'اسم الكيان القانوني',
  vatNumber: 'الرقم الضريبي',
  vatHint: '15 رقمًا، يبدأ وينتهي بالرقم 3',
  crNumber: 'رقم السجل التجاري',
  crHint: '10 أرقام',
  noAccount: 'جديد على Backhouse؟',
  haveAccount: 'لديك حساب؟',
  acceptInvite: 'الانضمام إلى المؤسسة',
  acceptInviteTitle: 'تمت دعوتك',
  acceptInviteHint: 'إذا كان لديك حساب، أدخل كلمة المرور الخاصة به.',
  pickOrg: 'اختر مؤسسة',
  overviewSub: 'مؤسستك في لمحة',
  gettingStarted: 'خطوات البدء',
  stepEntity: 'أضف الكيان القانوني مع الرقم الضريبي والسجل التجاري',
  stepSite: 'أضف أول فرع',
  stepLocations: 'أضف مواقع التخزين لكل فرع',
  stepTeam: 'ادعُ فريقك',
  done: 'مكتمل',
  todo: 'متبقٍ',
  legalEntities: 'الكيانات القانونية',
  storageLocations: 'مواقع التخزين',
  comingNext: 'القادم',
  comingNextBody: 'أوامر الشراء والموافقات واستلام التوريدات في المرحلة الثانية.',
  sitesSub: 'الفروع والمطابخ المركزية والمستودعات',
  addSite: 'إضافة فرع',
  siteName: 'اسم الفرع',
  siteNameAr: 'اسم الفرع بالعربية',
  siteCode: 'الرمز',
  siteType: 'النوع',
  restaurant: 'مطعم',
  central_kitchen: 'مطبخ مركزي',
  warehouse: 'مستودع',
  legalEntity: 'الكيان القانوني',
  city: 'المدينة',
  district: 'الحي',
  active: 'نشط',
  inactive: 'غير نشط',
  noSites: 'لا توجد فروع بعد',
  noSitesBody: 'أضف أول فرع لبدء تتبع المخزون.',
  locations: 'المواقع',
  addLocation: 'إضافة موقع',
  locationName: 'اسم الموقع',
  locationNameAr: 'اسم الموقع بالعربية',
  noLocations: 'لا توجد مواقع تخزين بعد',
  noLocationsBody: 'مثل غرفة التبريد، الفريزر، المخزن الجاف، البار.',
  timezone: 'المنطقة الزمنية',
  details: 'التفاصيل',
  membersSub: 'الأشخاص وصلاحياتهم',
  invite: 'دعوة',
  inviteTitle: 'دعوة عضو',
  role: 'الدور',
  allSites: 'كل الفروع',
  limitSites: 'تحديد الفروع',
  inviteLink: 'رابط الدعوة',
  inviteLinkHint: 'شارك هذا الرابط. تنتهي صلاحيته خلال 7 أيام. الإرسال بالبريد وواتساب لاحقًا.',
  copy: 'نسخ',
  copied: 'تم النسخ',
  pendingInvites: 'دعوات معلقة',
  revoke: 'إلغاء',
  remove: 'إزالة',
  confirm: 'اضغط مرة أخرى للتأكيد',
  expires: 'تنتهي',
  scopeOrg: 'كل المؤسسة',
  scopeSite: 'فروع محددة',
  changeRole: 'تغيير الدور',
  rolesSub: 'الأدوار المدمجة والمخصصة',
  addRole: 'إضافة دور',
  roleKey: 'المعرّف',
  roleName: 'اسم الدور',
  roleNameAr: 'اسم الدور بالعربية',
  scope: 'النطاق',
  permissions: 'الصلاحيات',
  system: 'مدمج',
  custom: 'مخصص',
  auditSub: 'كل تغيير، ومن قام به، ومتى',
  when: 'الوقت',
  who: 'المستخدم',
  action: 'الإجراء',
  entity: 'السجل',
  changes: 'التغييرات',
  before: 'قبل',
  after: 'بعد',
  loadMore: 'عرض المزيد',
  noEvents: 'لا توجد أحداث بعد',
  settingsSub: 'المؤسسة والكيانات القانونية',
  save: 'حفظ',
  saved: 'تم الحفظ',
  cancel: 'إلغاء',
  close: 'إغلاق',
  add: 'إضافة',
  edit: 'تعديل',
  addEntity: 'إضافة كيان قانوني',
  defaultLanguage: 'اللغة الافتراضية',
  vatRegistered: 'مسجل في ضريبة القيمة المضافة',
  insightsTitle: 'اسأل عن تكلفة الطعام',
  insightsLead: 'سيشرح وكيل Backhouse التكاليف والهدر وتغيرات الأسعار بكلمات بسيطة، ويقترح ما يجب فعله. يتصل ببياناتك عند تفعيل المشتريات والمخزون.',
  insightsSoon: 'معاينة. يعمل الوكيل في المرحلة الثامنة؛ الإجابات أدناه ببيانات تجريبية.',
  sampleData: 'بيانات تجريبية',
  askPlaceholder: 'اسأل أي شيء عن مطابخك',
  ask: 'اسأل',
  voice: 'صوت',
  q1: 'لماذا ارتفعت تكلفة الطعام هذا الأسبوع؟',
  q2: 'أي أسعار الموردين تغيرت؟',
  q3: 'أين يقع أكبر هدر؟',
  q4: 'ماذا يجب أن أطلب للغد؟',
  loading: 'جارٍ التحميل',
  error: 'حدث خطأ ما',
  errorBody: 'واجهت هذه الصفحة مشكلة وتم إبلاغنا بها. حاول مرة أخرى أو ارجع إلى صندوق المهام.',
  tryAgain: 'حاول مرة أخرى',
  backToInbox: 'العودة إلى صندوق المهام',
  required: 'مطلوب',
  optional: 'اختياري',
};

export type TKey = keyof Dict;
const dicts: Record<Lang, Dict> = { en, ar };

interface I18n {
  lang: Lang;
  dir: 'ltr' | 'rtl';
  t: (k: TKey) => string;
  setLang: (l: Lang) => void;
  /** Pick name or nameAr depending on language. */
  pick: (o: { name: string; nameAr?: string | null }) => string;
  /** Latin digits and Gregorian dates in both languages (matches VAT/CR numbers and invoices). */
  locale: string;
  fmtNum: (n: number, digits?: number) => string;
  fmtDate: (iso: string) => string;
  /** Amount in the organisation's currency (or the one given), e.g. "54.00 ر.س" / "SAR 54.00". */
  fmtMoney: (v: string | number | null | undefined, digits?: number, currency?: string | null) => string;
  /** The current organisation's currency (set when the session loads). */
  currency: string;
  setCurrency: (c: string) => void;
  /** Base quantity shown in a friendly unit (g→kg, ml→L). */
  fmtQty: (base: string | number, baseUnit: string) => string;
  /** Cost per base unit shown per kg / per L / each. */
  fmtUnitCost: (costPerBase: string | number | null | undefined, baseUnit: string) => string;
}

/** Arabic currency abbreviations (written after the amount). */
export const CURRENCY_AR: Record<string, string> = { SAR: 'ر.س', AED: 'د.إ', BHD: 'د.ب', KWD: 'د.ك', OMR: 'ر.ع', QAR: 'ر.ق', EGP: 'ج.م', JOD: 'د.أ' };

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children, initialLang }: { children: ReactNode; initialLang: Lang }) {
  const [lang, setLangState] = useState<Lang>(initialLang);
  const [currency, setCurrency] = useState('SAR');

  const setLang = useCallback((l: Lang) => {
    setLangState(l);
    document.documentElement.lang = l;
    document.documentElement.dir = l === 'ar' ? 'rtl' : 'ltr';
    try {
      localStorage.setItem('boh.lang', l);
    } catch {}
    document.cookie = `boh_lang=${l};path=/;max-age=31536000;samesite=lax`;
  }, []);

  const value: I18n = {
    lang,
    dir: lang === 'ar' ? 'rtl' : 'ltr',
    t: (k) => dicts[lang][k] ?? en[k],
    setLang,
    pick: (o) => (lang === 'ar' && o.nameAr ? o.nameAr : o.name),
    locale: lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB',
    fmtNum: (n, digits = 0) =>
      n.toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits }),
    currency,
    setCurrency,
    fmtMoney: (v, digits = 2, cur) => {
      if (v === null || v === undefined || v === '') return '–';
      const n = Number(v).toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { minimumFractionDigits: digits, maximumFractionDigits: digits });
      const c = (cur || currency).toUpperCase();
      return lang === 'ar' ? `${n} ${CURRENCY_AR[c] ?? c}` : `${c} ${n}`;
    },
    fmtQty: (base, baseUnit) => {
      const n = Number(base);
      const nf = (x: number) => x.toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { maximumFractionDigits: 3 });
      if (baseUnit === 'g') return Math.abs(n) >= 1000 ? `${nf(n / 1000)} ${lang === 'ar' ? 'كجم' : 'kg'}` : `${nf(n)} ${lang === 'ar' ? 'غ' : 'g'}`;
      if (baseUnit === 'ml') return Math.abs(n) >= 1000 ? `${nf(n / 1000)} ${lang === 'ar' ? 'لتر' : 'L'}` : `${nf(n)} ${lang === 'ar' ? 'مل' : 'ml'}`;
      return `${nf(n)} ${lang === 'ar' ? 'حبة' : 'each'}`;
    },
    fmtUnitCost: (c, baseUnit) => {
      if (c === null || c === undefined) return '–';
      const factor = baseUnit === 'each' ? 1 : 1000;
      const per = baseUnit === 'g' ? dicts[lang].perKg : baseUnit === 'ml' ? dicts[lang].perL : dicts[lang].perEach;
      const n = (Number(c) * factor).toLocaleString(lang === 'ar' ? 'ar-SA-u-nu-latn' : 'en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      return lang === 'ar' ? `${n} ${CURRENCY_AR[currency] ?? currency} ${per}` : `${currency} ${n} ${per}`;
    },
    fmtDate: (iso) =>
      new Date(iso).toLocaleDateString(lang === 'ar' ? 'ar-SA-u-ca-gregory-nu-latn' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}
