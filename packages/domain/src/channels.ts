/*
 * Messaging channel helpers (WhatsApp). Pure: no I/O.
 */

const AR_DIGITS: Record<string, string> = {
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
};

const COUNTRY_CODES: Record<string, string> = { SA: '966', AE: '971' };

/**
 * Normalise a phone number to E.164. Accepts Arabic-Indic digits, spaces, dashes,
 * "00" prefixes and local mobile formats for Saudi Arabia (05XXXXXXXX) and the UAE (05XXXXXXXX).
 * Returns null when the result is not a plausible number.
 */
export function normalizePhone(input: string, defaultCountry: 'SA' | 'AE' = 'SA'): string | null {
  let s = [...input.trim()].map((c) => AR_DIGITS[c] ?? c).join('');
  const plus = s.startsWith('+');
  s = s.replace(/[^\d]/g, '');
  if (!s) return null;
  if (!plus) {
    if (s.startsWith('00')) s = s.slice(2);
    else if (s.startsWith('0')) s = COUNTRY_CODES[defaultCountry] + s.slice(1);
    else if (s.length === 9 && s.startsWith('5')) s = COUNTRY_CODES[defaultCountry] + s;
  }
  // Saudi and UAE mobiles: 9 digits after the country code, starting with 5.
  if ((s.startsWith('966') || s.startsWith('971')) && !/^9(66|71)5\d{8}$/.test(s)) return null;
  if (!/^[1-9]\d{7,14}$/.test(s)) return null;
  return `+${s}`;
}

/** Digits only, as WhatsApp sends and expects ("966501234567"). */
export const waId = (e164: string) => e164.replace(/^\+/, '');

/**
 * WhatsApp's customer service window: businesses may send free-form (non-template) messages
 * for 24 hours after the person's last message. A safety margin avoids racing the boundary.
 */
export function inServiceWindow(lastInboundAt: Date | null | undefined, now: Date = new Date(), marginMinutes = 10): boolean {
  if (!lastInboundAt) return false;
  return now.getTime() - lastInboundAt.getTime() < (24 * 60 - marginMinutes) * 60_000;
}

/** WhatsApp limits. */
export const WA_LIMITS = { body: 1024, buttonTitle: 20, buttonId: 256, templateParam: 1024, text: 4096 } as const;

/** Clip to a limit, ending with an ellipsis when cut. Counts code points, not UTF-16 units. */
export function clip(text: string, max: number): string {
  const chars = [...text];
  return chars.length <= max ? text : chars.slice(0, max - 1).join('').trimEnd() + '…';
}

/** WhatsApp template parameters cannot contain newlines, tabs or more than 4 consecutive spaces. */
export function templateParam(text: string, max: number = WA_LIMITS.templateParam): string {
  return clip(text.replace(/[\r\n\t]+/g, ' · ').replace(/ {2,}/g, ' ').trim() || '-', max);
}

export type ButtonDecision = 'approve' | 'reject';

/** Button payload for an approval prompt: "apr:<promptId>:<a|r>". */
export function approvalPayload(promptId: string, decision: ButtonDecision): string {
  return `apr:${promptId}:${decision === 'approve' ? 'a' : 'r'}`;
}

export function parseApprovalPayload(payload: string): { promptId: string; decision: ButtonDecision } | null {
  const m = /^apr:([0-9a-f-]{36}):([ar])$/i.exec(payload.trim());
  return m ? { promptId: m[1]!.toLowerCase(), decision: m[2] === 'a' ? 'approve' : 'reject' } : null;
}

/** Link codes people send from WhatsApp: "BOH-" + 6 characters without look-alikes (0/O, 1/I/L). */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export function linkCode(random: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 6; i++) out += CODE_ALPHABET[random[i]! % CODE_ALPHABET.length];
  return `BOH-${out}`;
}

/** Finds a link code in a message, tolerating case, spaces, Arabic digits and a missing dash. */
export function findLinkCode(text: string): string | null {
  const s = [...text].map((c) => AR_DIGITS[c] ?? c).join('').toUpperCase();
  const m = /\bBOH[\s-]?([2-9A-HJKMNP-Z]{6})\b/.exec(s);
  return m ? `BOH-${m[1]}` : null;
}
