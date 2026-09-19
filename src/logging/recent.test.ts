import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { recentLogProblems } from './recent.js';

let dir: string;

const line = (level: number, time: string, msg: string, extra: object = {}) =>
  JSON.stringify({ level, time, msg, ...extra });

function writeLog(name: string, lines: string[], mtimeS: number) {
  const path = join(dir, name);
  writeFileSync(path, `${lines.join('\n')}\n`);
  utimesSync(path, mtimeS, mtimeS);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ts3a-logs-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('recentLogProblems', () => {
  it('returns warnings and errors newest first, across files, with folded repeats', () => {
    writeLog(
      'ts3-analytics.2026-09-18.1.log',
      [
        line(50, '2026-09-18T10:00:00.000Z', 'Job failed', { job: 'retention' }),
        line(30, '2026-09-18T11:00:00.000Z', 'Job finished'),
      ],
      1000,
    );
    writeLog(
      'ts3-analytics.2026-09-19.1.log',
      [
        line(40, '2026-09-19T08:00:00.000Z', 'TS3 connection failed', {
          err: { message: 'connect ECONNREFUSED 10.0.0.5:10011' },
        }),
        line(40, '2026-09-19T08:00:10.000Z', 'TS3 connection failed', {
          err: { message: 'connect ECONNREFUSED 10.0.0.5:10011' },
        }),
        'not json',
        line(60, '2026-09-19T09:00:00.000Z', 'Crashed'),
      ],
      2000,
    );
    writeFileSync(join(dir, 'other.log'), line(50, '2026-09-19T10:00:00.000Z', 'ignored'));

    expect(recentLogProblems(dir)).toEqual([
      {
        at: Date.parse('2026-09-19T09:00:00Z') / 1000,
        level: 'fatal',
        message: 'Crashed',
        detail: undefined,
        count: 1,
      },
      {
        at: Date.parse('2026-09-19T08:00:10Z') / 1000,
        level: 'warn',
        message: 'TS3 connection failed',
        detail: 'connect ECONNREFUSED [IP]:10011',
        count: 2,
      },
      {
        at: Date.parse('2026-09-18T10:00:00Z') / 1000,
        level: 'error',
        message: 'Job failed',
        detail: 'Job retention',
        count: 1,
      },
    ]);
  });

  it('respects the limit and only reads the end of large files', () => {
    const lines = Array.from({ length: 50 }, (_, i) =>
      line(50, new Date(Date.UTC(2026, 8, 19, 0, i)).toISOString(), `Fehler ${String(i)}`),
    );
    writeLog('ts3-analytics.2026-09-19.1.log', lines, 1000);
    const limited = recentLogProblems(dir, { limit: 3 });
    expect(limited.map((p) => p.message)).toEqual(['Fehler 49', 'Fehler 48', 'Fehler 47']);
    const tail = recentLogProblems(dir, { limit: 100, maxBytes: 400 });
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.length).toBeLessThan(10);
    expect(tail[0]?.message).toBe('Fehler 49');
  });

  it('returns nothing for a missing directory', () => {
    expect(recentLogProblems(join(dir, 'missing'))).toEqual([]);
  });
});
