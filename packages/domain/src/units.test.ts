import { describe, expect, it } from 'vitest';
import { convert, costPerBase, packToBase, toBase, UnitError, type PackDef } from './units.js';
import { isValidKsaCrNumber, isValidKsaVatNumber } from './ksa.js';

const s = (d: { toString(): string }) => d.toString();

describe('convert', () => {
  it('converts within a dimension exactly', () => {
    expect(s(convert('2.5', 'kg', 'g'))).toBe('2500');
    expect(s(convert(1500, 'ml', 'l'))).toBe('1.5');
    expect(s(convert(2, 'dozen', 'each'))).toBe('24');
  });

  it('avoids float drift', () => {
    expect(s(convert('0.1', 'kg', 'g').plus(convert('0.2', 'kg', 'g')))).toBe('300');
  });

  it('rejects cross-dimension without item conversion', () => {
    expect(() => convert(1, 'kg', 'l')).toThrow(UnitError);
  });

  it('converts across dimensions with item conversions', () => {
    const oil = [{ from: { qty: 1, unit: 'l' }, to: { qty: 920, unit: 'g' } }];
    expect(s(convert(2, 'l', 'kg', oil))).toBe('1.84');
    expect(s(convert(460, 'g', 'ml', oil))).toBe('500');
  });

  it('chains conversions through an intermediate dimension', () => {
    // 1 each = 55 g, 1 ml = 1.03 g  => each -> ml via mass
    const egg = [
      { from: { qty: 1, unit: 'each' }, to: { qty: 55, unit: 'g' } },
      { from: { qty: 1, unit: 'ml' }, to: { qty: '1.1', unit: 'g' } },
    ];
    expect(s(convert(2, 'each', 'ml', egg))).toBe('100');
  });

  it('rejects unknown units and same-dimension item conversions', () => {
    expect(() => convert(1, 'stone', 'g')).toThrow(/Unknown unit/);
    expect(() => convert(1, 'kg', 'l', [{ from: { qty: 1, unit: 'kg' }, to: { qty: 1000, unit: 'g' } }])).toThrow(
      /cross dimensions/,
    );
  });
});

describe('packs', () => {
  const packs: PackDef[] = [
    { id: 'bottle', name: 'Bottle 1L', qty: 1, unit: 'l' },
    { id: 'case', name: 'Case 6×1L', qty: 6, packId: 'bottle' },
    { id: 'pallet', name: 'Pallet 40 cases', qty: 40, packId: 'case' },
  ];

  it('resolves nested packs to base', () => {
    expect(s(packToBase('case', packs, 'ml'))).toBe('6000');
    expect(s(packToBase('pallet', packs, 'ml'))).toBe('240000');
  });

  it('detects cycles', () => {
    const bad: PackDef[] = [
      { id: 'a', name: 'A', qty: 2, packId: 'b' },
      { id: 'b', name: 'B', qty: 2, packId: 'a' },
    ];
    expect(() => packToBase('a', bad, 'g')).toThrow(/cycle/);
  });

  it('rejects malformed packs', () => {
    expect(() => packToBase('x', [{ id: 'x', name: 'X', qty: 0, unit: 'g' }], 'g')).toThrow(/positive/);
    expect(() => packToBase('x', [{ id: 'x', name: 'X', qty: 1 }], 'g')).toThrow(/exactly one/);
  });

  it('computes cost per base unit from a pack price', () => {
    const item = { baseUnit: 'ml', packs };
    // 54 SAR per case of 6 L → 0.009 SAR per ml
    expect(s(costPerBase(54, { packId: 'case' }, item))).toBe('0.009');
    expect(s(toBase('2.5', { packId: 'case' }, item))).toBe('15000');
  });

  it('supports packs of count items sold by weight', () => {
    const item = {
      baseUnit: 'each',
      packs: [{ id: 'tray', name: 'Tray 30', qty: 30, unit: 'each' }],
      conversions: [{ from: { qty: 1, unit: 'each' }, to: { qty: 60, unit: 'g' } }],
    };
    expect(s(toBase('1.8', { unit: 'kg' }, item))).toBe('30');
  });
});

describe('KSA identifiers', () => {
  it('validates VAT numbers', () => {
    expect(isValidKsaVatNumber('300000000000003')).toBe(true);
    expect(isValidKsaVatNumber('310122393500003')).toBe(true);
    expect(isValidKsaVatNumber('200000000000003')).toBe(false);
    expect(isValidKsaVatNumber('30000000000003')).toBe(false);
  });
  it('validates CR numbers', () => {
    expect(isValidKsaCrNumber('1010123456')).toBe(true);
    expect(isValidKsaCrNumber('101012345')).toBe(false);
  });
});
