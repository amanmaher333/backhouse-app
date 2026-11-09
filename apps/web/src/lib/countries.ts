/*
 * Countries Backhouse supports, for forms (the API holds the full rules in
 * @boh/domain's country profiles and checks every number server-side).
 */

export interface CountryUi {
  code: string;
  name: string;
  nameAr: string;
  phone: string;
  vatLabel: [string, string];
  vatHint: [string, string] | null;
  crHint: [string, string];
}

const freeCr: [string, string] = ['Commercial registration or trade licence', 'السجل التجاري أو الرخصة التجارية'];

export const COUNTRIES_UI: CountryUi[] = [
  { code: 'SA', name: 'Saudi Arabia', nameAr: 'السعودية', phone: '+9665XXXXXXXX', vatLabel: ['VAT number', 'الرقم الضريبي'], vatHint: ['15 digits, starting and ending with 3', '15 رقمًا يبدأ وينتهي بـ 3'], crHint: ['10 digits', '10 أرقام'] },
  { code: 'AE', name: 'United Arab Emirates', nameAr: 'الإمارات', phone: '+9715XXXXXXXX', vatLabel: ['TRN', 'رقم التسجيل الضريبي'], vatHint: ['15 digits, starting with 100', '15 رقمًا يبدأ بـ 100'], crHint: freeCr },
  { code: 'BH', name: 'Bahrain', nameAr: 'البحرين', phone: '+973XXXXXXXX', vatLabel: ['VAT account number', 'رقم حساب الضريبة'], vatHint: ['15 digits', '15 رقمًا'], crHint: freeCr },
  { code: 'KW', name: 'Kuwait', nameAr: 'الكويت', phone: '+965XXXXXXXX', vatLabel: ['Tax number', 'الرقم الضريبي'], vatHint: null, crHint: freeCr },
  { code: 'OM', name: 'Oman', nameAr: 'عُمان', phone: '+968XXXXXXXX', vatLabel: ['VATIN', 'رقم التعريف الضريبي'], vatHint: ['OM followed by 10 digits', 'OM ثم 10 أرقام'], crHint: freeCr },
  { code: 'QA', name: 'Qatar', nameAr: 'قطر', phone: '+974XXXXXXXX', vatLabel: ['Tax number', 'الرقم الضريبي'], vatHint: null, crHint: freeCr },
  { code: 'EG', name: 'Egypt', nameAr: 'مصر', phone: '+201XXXXXXXXX', vatLabel: ['Tax registration number', 'رقم التسجيل الضريبي'], vatHint: ['9 digits', '9 أرقام'], crHint: freeCr },
  { code: 'JO', name: 'Jordan', nameAr: 'الأردن', phone: '+9627XXXXXXXX', vatLabel: ['Tax number', 'الرقم الضريبي'], vatHint: ['6 to 12 digits', 'من 6 إلى 12 رقمًا'], crHint: freeCr },
];

export const countryUi = (code: string | null | undefined) => COUNTRIES_UI.find((c) => c.code === (code ?? 'SA')) ?? COUNTRIES_UI[0]!;

/** Common IANA time zones for the region (the API accepts any valid one). */
export const REGION_TIME_ZONES = ['Asia/Riyadh', 'Asia/Dubai', 'Asia/Qatar', 'Asia/Bahrain', 'Asia/Kuwait', 'Asia/Muscat', 'Africa/Cairo', 'Asia/Amman'];
