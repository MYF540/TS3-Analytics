import { describe, expect, it } from 'vitest';
import { csvDateTime, hours, toCsv } from './csv.js';

describe('toCsv', () => {
  it('writes a BOM, semicolons, CRLF and decimal commas', () => {
    expect(
      toCsv(
        ['Name', 'Stunden'],
        [
          ['Alice', 12.5],
          ['Bob', null],
        ],
      ),
    ).toBe('﻿Name;Stunden\r\nAlice;12,5\r\nBob;\r\n');
  });

  it('quotes separators, quotes and line breaks', () => {
    const csv = toCsv(['Nick'], [['a;b'], ['say "hi"'], ['two\nlines'], [' padded ']]);
    expect(csv.split('\r\n').slice(1, 5)).toEqual([
      '"a;b"',
      '"say ""hi"""',
      '"two\nlines"',
      '" padded "',
    ]);
  });

  it('neutralises spreadsheet formulas in text cells', () => {
    const csv = toCsv(
      ['Nick'],
      [['=HYPERLINK("http://evil")'], ['+1'], ['-2'], ['@SUM(A1)'], ['normal']],
    );
    expect(csv.split('\r\n').slice(1, 6)).toEqual([
      `"'=HYPERLINK(""http://evil"")"`,
      "'+1",
      "'-2",
      "'@SUM(A1)",
      'normal',
    ]);
  });

  it('keeps negative numbers as numbers', () => {
    expect(toCsv(['n'], [[-1.5]])).toContain('\r\n-1,5\r\n');
  });
});

describe('helpers', () => {
  it('converts seconds to hours with two decimals', () => {
    expect(hours(5400)).toBe(1.5);
    expect(hours(100)).toBe(0.03);
  });

  it('formats Berlin date and time', () => {
    expect(csvDateTime(Date.parse('2026-09-19T12:30:00Z') / 1000)).toBe('2026-09-19 14:30');
  });
});
