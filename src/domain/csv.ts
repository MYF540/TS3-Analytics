/**
 * CSV for German spreadsheet programs (pure): UTF-8 with BOM, `;` as separator, CRLF line ends,
 * decimal comma. Cells that a spreadsheet would treat as a formula are neutralised, because
 * nicknames are user-controlled (CSV/formula injection).
 */

export type CsvCell = string | number | boolean | null | undefined;

const BOM = '﻿';
const SEPARATOR = ';';
const FORMULA_START = /^[=+\-@\t\r]/;

function cell(value: CsvCell): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'number' ? String(value).replace('.', ',') : String(value);
  if (typeof value === 'string' && FORMULA_START.test(text)) text = `'${text}`;
  return /[;"\r\n]|^\s|\s$/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCsv(headers: readonly string[], rows: Iterable<readonly CsvCell[]>): string {
  const lines = [headers.map(cell).join(SEPARATOR)];
  for (const row of rows) lines.push(row.map(cell).join(SEPARATOR));
  return `${BOM}${lines.join('\r\n')}\r\n`;
}

/** Seconds → hours with two decimals (the separator becomes a comma in `toCsv`). */
export function hours(seconds: number): number {
  return Math.round((seconds / 3600) * 100) / 100;
}

const dateTime = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Berlin',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Unix seconds → `YYYY-MM-DD HH:MM` in Berlin time (sortable, understood by spreadsheets). */
export function csvDateTime(unixSeconds: number): string {
  return dateTime.format(new Date(unixSeconds * 1000));
}
