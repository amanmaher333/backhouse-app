import { describe, expect, it } from 'vitest';
import { approvalPayload, clip, findLinkCode, inServiceWindow, linkCode, normalizePhone, parseApprovalPayload, templateParam } from './channels.js';

describe('normalizePhone', () => {
  it('handles Saudi local, international and Arabic-digit formats', () => {
    expect(normalizePhone('0501234567')).toBe('+966501234567');
    expect(normalizePhone('050 123 4567')).toBe('+966501234567');
    expect(normalizePhone('501234567')).toBe('+966501234567');
    expect(normalizePhone('00966501234567')).toBe('+966501234567');
    expect(normalizePhone('+966 50-123-4567')).toBe('+966501234567');
    expect(normalizePhone('٠٥٠١٢٣٤٥٦٧')).toBe('+966501234567');
  });
  it('handles the UAE and other countries', () => {
    expect(normalizePhone('0501234567', 'AE')).toBe('+971501234567');
    expect(normalizePhone('+447700900123')).toBe('+447700900123');
  });
  it('rejects implausible numbers', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('12')).toBeNull();
    expect(normalizePhone('+96611234567')).toBeNull(); // Saudi landline, not WhatsApp-able mobile format
    expect(normalizePhone('05012345')).toBeNull();
  });
});

describe('service window', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  it('is open for 24 hours minus a margin after the last inbound message', () => {
    expect(inServiceWindow(null, now)).toBe(false);
    expect(inServiceWindow(new Date('2026-11-08T00:00:00Z'), now)).toBe(true);
    expect(inServiceWindow(new Date('2026-11-07T12:05:00Z'), now)).toBe(false); // inside the 10-minute margin
    expect(inServiceWindow(new Date('2026-11-07T11:00:00Z'), now)).toBe(false);
  });
});

describe('text limits', () => {
  it('clips by code points and cleans template parameters', () => {
    expect(clip('طلب جديد', 20)).toBe('طلب جديد');
    expect([...clip('أ'.repeat(30), 20)].length).toBe(20);
    expect(templateParam('line one\nline two    end')).toBe('line one · line two end');
    expect(templateParam('')).toBe('-');
  });
});

describe('payloads and link codes', () => {
  it('round-trips approval payloads and rejects junk', () => {
    const id = '0b6d2f7e-8f1a-4c4e-9a59-1f6f5f6b7c8d';
    expect(parseApprovalPayload(approvalPayload(id, 'approve'))).toEqual({ promptId: id, decision: 'approve' });
    expect(parseApprovalPayload(approvalPayload(id, 'reject'))).toEqual({ promptId: id, decision: 'reject' });
    expect(parseApprovalPayload('apr:not-a-uuid:a')).toBeNull();
    expect(parseApprovalPayload(`apr:${id}:x`)).toBeNull();
  });
  it('makes and finds link codes without look-alike characters', () => {
    const code = linkCode(new Uint8Array([0, 1, 2, 3, 4, 30]));
    expect(code).toMatch(/^BOH-[2-9A-HJKMNP-Z]{6}$/);
    expect(findLinkCode(`my code is ${code.toLowerCase()}`)).toBe(code);
    expect(findLinkCode(code.replace('-', ' '))).toBe(code);
    expect(findLinkCode('hello')).toBeNull();
  });
});

import { digestDue, digestIsEmpty, digestSummary } from './channels.js';

describe('daily digest', () => {
  it('is due from the chosen local hour for a few hours, per local day', () => {
    // 05:30 UTC = 08:30 in Riyadh
    expect(digestDue(new Date('2026-11-08T05:30:00Z'), 'Asia/Riyadh', 8)).toEqual({ due: true, localDate: '2026-11-08' });
    expect(digestDue(new Date('2026-11-08T04:59:00Z'), 'Asia/Riyadh', 8).due).toBe(false); // 07:59
    expect(digestDue(new Date('2026-11-08T09:00:00Z'), 'Asia/Riyadh', 8).due).toBe(false); // 12:00, past the grace period
    // Dubai is an hour ahead: 05:30 UTC = 09:30
    expect(digestDue(new Date('2026-11-08T05:30:00Z'), 'Asia/Dubai', 9).due).toBe(true);
    // 22:30 UTC on the 7th is already the 8th in Riyadh
    expect(digestDue(new Date('2026-11-07T22:30:00Z'), 'Asia/Riyadh', 1).localDate).toBe('2026-11-08');
  });

  it('summarises counts on one line in both languages', () => {
    const c = { waiting: 3, autoDone: 1, pendingSpend: 0, dueToday: 2, late: 1, lowItems: 4, lowSites: 2, priceRises: 0 };
    expect(digestSummary(c, 'en')).toBe('3 decisions waiting · 1 done by agents · 2 deliveries today · 1 late · 4 items low');
    expect(digestSummary(c, 'ar')).toBe('3 بانتظار قرارك · 1 نفّذها الوكلاء · 2 توريد اليوم · 1 متأخر · 4 صنف منخفض');
    expect(digestIsEmpty({ ...c, waiting: 0, autoDone: 0, dueToday: 0, late: 0, lowItems: 0, lowSites: 0 })).toBe(true);
    expect(digestSummary({ ...c, waiting: 0, autoDone: 0, dueToday: 0, late: 0, lowItems: 0, lowSites: 0 }, 'en')).toBe('Nothing new');
  });
});

import { parseSupplierPayload, supplierPayload } from './channels.js';
describe('supplier payloads', () => {
  it('round-trips confirm and problem', () => {
    const id = '7d1c9f8e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
    expect(parseSupplierPayload(supplierPayload(id, 'confirm'))).toEqual({ linkId: id, answer: 'confirm' });
    expect(parseSupplierPayload(supplierPayload(id, 'problem'))).toEqual({ linkId: id, answer: 'problem' });
    expect(parseSupplierPayload(`apr:${id}:a`)).toBeNull();
  });
});
