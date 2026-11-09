import { Decimal } from 'decimal.js';

/*
 * What differs by country: currency, VAT, time zone, phone numbers, company and
 * tax identifiers, and which e-invoicing and company register integrations apply.
 * Backhouse sells in Saudi Arabia first, but nothing outside a country's own
 * integrations (ZATCA, Wathq) should assume it.
 */

export interface CountryProfile {
  code: string;
  name: string;
  nameAr: string;
  currency: string;
  /** Arabic currency abbreviation, written after the amount. */
  currencyAr: string;
  /** Minor units of the currency (3 for BHD, KWD, OMR, JOD). Amounts are stored to 2 decimals for now. */
  currencyDecimals: number;
  timezone: string;
  /** Standard VAT/GST rate as a fraction; 0 where there is no VAT. */
  vatRate: string;
  /** International dialling code, digits only. */
  phoneCode: string;
  /** National mobile number pattern (after the country code), for WhatsApp numbers. */
  mobile: RegExp;
  /** Local numbers start with a trunk "0" (e.g. 05XXXXXXXX). */
  trunkZero: boolean;
  vatLabel: string;
  vatLabelAr: string;
  /** Tax registration number format, or null where there is no VAT registration. */
  vatNumber: { pattern: RegExp; hint: string } | null;
  crNumber: { pattern: RegExp; hint: string };
  /** Mandatory e-invoicing integration Backhouse supports there. */
  eInvoicing: 'zatca' | null;
  /** Commercial register Backhouse checks automatically. */
  registry: 'wathq' | null;
  defaultLocale: 'ar' | 'en';
}

const freeCr = { pattern: /^[A-Za-z0-9/-]{3,30}$/, hint: 'Commercial registration or trade licence number' };

export const COUNTRIES: Record<string, CountryProfile> = {
  SA: {
    code: 'SA', name: 'Saudi Arabia', nameAr: 'المملكة العربية السعودية', currency: 'SAR', currencyAr: 'ر.س', currencyDecimals: 2,
    timezone: 'Asia/Riyadh', vatRate: '0.15', phoneCode: '966', mobile: /^5\d{8}$/, trunkZero: true,
    vatLabel: 'VAT number', vatLabelAr: 'الرقم الضريبي',
    vatNumber: { pattern: /^3\d{13}3$/, hint: '15 digits, starting and ending with 3' },
    crNumber: { pattern: /^\d{10}$/, hint: '10 digits' },
    eInvoicing: 'zatca', registry: 'wathq', defaultLocale: 'ar',
  },
  AE: {
    code: 'AE', name: 'United Arab Emirates', nameAr: 'الإمارات العربية المتحدة', currency: 'AED', currencyAr: 'د.إ', currencyDecimals: 2,
    timezone: 'Asia/Dubai', vatRate: '0.05', phoneCode: '971', mobile: /^5\d{8}$/, trunkZero: true,
    vatLabel: 'TRN', vatLabelAr: 'رقم التسجيل الضريبي',
    vatNumber: { pattern: /^100\d{12}$/, hint: '15 digits, starting with 100' },
    crNumber: freeCr, eInvoicing: null, registry: null, defaultLocale: 'ar',
  },
  BH: {
    code: 'BH', name: 'Bahrain', nameAr: 'البحرين', currency: 'BHD', currencyAr: 'د.ب', currencyDecimals: 3,
    timezone: 'Asia/Bahrain', vatRate: '0.10', phoneCode: '973', mobile: /^[36]\d{7}$/, trunkZero: false,
    vatLabel: 'VAT account number', vatLabelAr: 'رقم حساب ضريبة القيمة المضافة',
    vatNumber: { pattern: /^\d{15}$/, hint: '15 digits' },
    crNumber: freeCr, eInvoicing: null, registry: null, defaultLocale: 'ar',
  },
  KW: {
    code: 'KW', name: 'Kuwait', nameAr: 'الكويت', currency: 'KWD', currencyAr: 'د.ك', currencyDecimals: 3,
    timezone: 'Asia/Kuwait', vatRate: '0', phoneCode: '965', mobile: /^[569]\d{7}$/, trunkZero: false,
    vatLabel: 'Tax number', vatLabelAr: 'الرقم الضريبي', vatNumber: null,
    crNumber: freeCr, eInvoicing: null, registry: null, defaultLocale: 'ar',
  },
  OM: {
    code: 'OM', name: 'Oman', nameAr: 'عُمان', currency: 'OMR', currencyAr: 'ر.ع', currencyDecimals: 3,
    timezone: 'Asia/Muscat', vatRate: '0.05', phoneCode: '968', mobile: /^[79]\d{7}$/, trunkZero: false,
    vatLabel: 'VATIN', vatLabelAr: 'رقم التعريف الضريبي',
    vatNumber: { pattern: /^OM\d{10}$/i, hint: 'OM followed by 10 digits' },
    crNumber: freeCr, eInvoicing: null, registry: null, defaultLocale: 'ar',
  },
  QA: {
    code: 'QA', name: 'Qatar', nameAr: 'قطر', currency: 'QAR', currencyAr: 'ر.ق', currencyDecimals: 2,
    timezone: 'Asia/Qatar', vatRate: '0', phoneCode: '974', mobile: /^[3567]\d{7}$/, trunkZero: false,
    vatLabel: 'Tax number', vatLabelAr: 'الرقم الضريبي', vatNumber: null,
    crNumber: freeCr, eInvoicing: null, registry: null, defaultLocale: 'ar',
  },
  EG: {
    code: 'EG', name: 'Egypt', nameAr: 'مصر', currency: 'EGP', currencyAr: 'ج.م', currencyDecimals: 2,
    timezone: 'Africa/Cairo', vatRate: '0.14', phoneCode: '20', mobile: /^1[0125]\d{8}$/, trunkZero: true,
    vatLabel: 'Tax registration number', vatLabelAr: 'رقم التسجيل الضريبي',
    vatNumber: { pattern: /^\d{9}$/, hint: '9 digits' },
    crNumber: freeCr, eInvoicing: null, registry: null, defaultLocale: 'ar',
  },
  JO: {
    code: 'JO', name: 'Jordan', nameAr: 'الأردن', currency: 'JOD', currencyAr: 'د.أ', currencyDecimals: 3,
    timezone: 'Asia/Amman', vatRate: '0.16', phoneCode: '962', mobile: /^7[789]\d{7}$/, trunkZero: true,
    vatLabel: 'Tax number', vatLabelAr: 'الرقم الضريبي',
    vatNumber: { pattern: /^\d{6,12}$/, hint: '6 to 12 digits' },
    crNumber: freeCr, eInvoicing: null, registry: null, defaultLocale: 'ar',
  },
};

export const COUNTRY_CODES = Object.keys(COUNTRIES);
export const DEFAULT_COUNTRY = 'SA';

/** The profile for a country; unknown codes fall back to Saudi Arabia's. */
export function country(code: string | null | undefined): CountryProfile {
  return COUNTRIES[(code ?? DEFAULT_COUNTRY).toUpperCase()] ?? COUNTRIES[DEFAULT_COUNTRY]!;
}

export const isSupportedCountry = (code: string | null | undefined) => Boolean(code && COUNTRIES[code.toUpperCase()]);

/** Arabic abbreviation for a currency code (falls back to the code). */
export function currencyAr(code: string | null | undefined): string {
  const c = (code ?? 'SAR').toUpperCase();
  return Object.values(COUNTRIES).find((p) => p.currency === c)?.currencyAr ?? c;
}

/** "SAR 12.50" in English, "12.50 ر.س" in Arabic, Latin digits in both. */
export function formatMoney(amount: Decimal.Value | null | undefined, currency: string | null | undefined, lang: 'en' | 'ar' = 'en'): string {
  const n = new Decimal(amount ?? 0).toFixed(2);
  const c = (currency ?? 'SAR').toUpperCase();
  return lang === 'ar' ? `${n} ${currencyAr(c)}` : `${c} ${n}`;
}

/** Both languages at once, for bilingual messages: [en, ar]. */
export const money2 = (amount: Decimal.Value | null | undefined, currency: string | null | undefined): [string, string] => [formatMoney(amount, currency, 'en'), formatMoney(amount, currency, 'ar')];

export function validVatNumber(countryCode: string | null | undefined, value: string): boolean {
  const p = country(countryCode).vatNumber;
  return p ? p.pattern.test(value.trim()) : value.trim().length > 0 && value.trim().length <= 30;
}

export function validCrNumber(countryCode: string | null | undefined, value: string): boolean {
  return country(countryCode).crNumber.pattern.test(value.trim());
}

/** True if the IANA time zone is known to this runtime. */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The UTC instant of a local wall-clock time in a time zone (e.g. midnight on the 1st in Cairo). */
export function zonedTimeToUtc(date: string, time: string, timeZone: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm, ss = 0] = time.split(':').map(Number) as [number, number, number?];
  const guess = Date.UTC(y, m - 1, d, hh, mm, ss);
  const offset = (t: number) => {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
        .formatToParts(new Date(t))
        .map((p) => [p.type, p.value]),
    );
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second)) - t;
  };
  // Two passes handle daylight-saving transitions.
  let t = guess - offset(guess);
  t = guess - offset(t);
  return new Date(t);
}
