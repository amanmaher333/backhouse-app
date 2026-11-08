import { describe, expect, it } from 'vitest';
import { normalizeName, normalizeArabic, hasArabic } from './text.js';
import { parseCsv, parseCsvObjects, writeCsv, CsvError } from './csv.js';
import { pctChange } from './catalog.js';

describe('normalizeName', () => {
  it('drops pack sizes and units in English', () => {
    expect(normalizeName('Tomato Rnd 1KG Jordan')).toBe('tomato rnd jordan');
    expect(normalizeName('TOMATOES (CTN 6KG)')).toBe('tomatoes');
    expect(normalizeName('Olive Oil 6x1L')).toBe('olive oil');
    expect(normalizeName('Milk Full Fat 2 Ltr')).toBe('milk full fat');
  });

  it('unifies Arabic letter variants, diacritics and digits', () => {
    expect(normalizeName('طَمَاطِم ١ كجم')).toBe('طماطم');
    expect(normalizeName('زيت زيتون - عبوة ٥ لتر')).toBe('زيت زيتون');
    expect(normalizeName('بيض طازج طبق 30 حبة')).toBe('بيض طازج');
    expect(normalizeArabic('أرز بسمتي')).toBe('ارز بسمتي');
    expect(normalizeArabic('كزبرة')).toBe('كزبره');
    expect(normalizeName('دجاج كامل 1100جم')).toBe('دجاج كامل');
  });

  it('keeps meaningful words', () => {
    expect(normalizeName('Chicken Breast Boneless Frozen')).toBe('chicken breast boneless frozen');
  });

  it('detects Arabic', () => {
    expect(hasArabic('طماطم')).toBe(true);
    expect(hasArabic('tomato')).toBe(false);
  });
});

describe('csv', () => {
  it('parses quotes, escaped quotes, newlines and CRLF', () => {
    const rows = parseCsv('a,b,c\r\n"x, y","he said ""hi""","line1\nline2"\r\n');
    expect(rows).toEqual([
      ['a', 'b', 'c'],
      ['x, y', 'he said "hi"', 'line1\nline2'],
    ]);
  });

  it('strips BOM, detects semicolons, maps headers', () => {
    const { headers, rows } = parseCsvObjects('﻿Name;Name AR;Base Unit\nTomato;طماطم;g\n\n');
    expect(headers).toEqual(['name', 'name_ar', 'base_unit']);
    expect(rows).toEqual([{ name: 'Tomato', name_ar: 'طماطم', base_unit: 'g' }]);
  });

  it('round-trips through writeCsv', () => {
    const text = writeCsv(['name', 'note'], [{ name: 'زيت, زيتون', note: 'says "ok"' }]);
    expect(text.startsWith('﻿')).toBe(true);
    expect(parseCsvObjects(text).rows).toEqual([{ name: 'زيت, زيتون', note: 'says "ok"' }]);
  });

  it('rejects unclosed quotes and empty input', () => {
    expect(() => parseCsv('a,"b')).toThrow(CsvError);
    expect(() => parseCsvObjects('')).toThrow(CsvError);
  });
});

describe('pctChange', () => {
  it('computes percentage change', () => {
    expect(pctChange(10, 11.4)).toBeCloseTo(14);
    expect(pctChange(null, 5)).toBeNull();
    expect(pctChange('0', 5)).toBeNull();
  });
});
