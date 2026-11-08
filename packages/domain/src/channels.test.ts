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
