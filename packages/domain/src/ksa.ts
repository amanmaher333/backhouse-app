/**
 * Saudi Arabia identifiers.
 * - VAT registration number (TRN): 15 digits, starts and ends with "3".
 * - Commercial Registration (CR): 10 digits.
 */

export function isValidKsaVatNumber(v: string): boolean {
  return /^3\d{13}3$/.test(v);
}

export function isValidKsaCrNumber(v: string): boolean {
  return /^\d{10}$/.test(v);
}

/** Standard KSA VAT rate (15% since July 2020). Stored as a string for Decimal use. */
export const KSA_STANDARD_VAT_RATE = '0.15';
