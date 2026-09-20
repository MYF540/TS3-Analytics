import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { rebuildAggregates } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import { berlinDay } from '../domain/time.js';
import type { ClientMap } from './client-map.js';
import { importLogs } from './log-import.js';

const dir = mkdtempSync(join(tmpdir(), 'ts3a-logimport-'));
const NOW = 1_600_000_000;
const UID_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';

const clients: ClientMap = new Map([
  [511, { dbid: 511, uid: UID_A, nickname: 'Alice', lastConnected: NOW }],
]);

let database: AppDatabase;
let fileCounter = 0;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

/** Writes a log file with the given message lines, timestamped in German local time. */
function logFile(lines: { time: string; message: string }[]): string {
  fileCounter++;
  const name = `ts3server_2020-01-0${String(fileCounter)}__00_00_00.000000_4.log`;
  const path = join(dir, name);
  writeFileSync(
    path,
    lines
      .map(
        ({ time, message }) => `2020-01-01 ${time}.000000|INFO    |VirtualServer |4  |${message}`,
      )
      .join('\n') + '\n',
  );
  return path;
}

const connect = (time: string, dbid = 511, nick = 'Alice', ip = '203.0.113.7') => ({
  time,
  message: `client connected '${nick}'(id:${String(dbid)}) from ${ip}:51234`,
});
const disconnect = (time: string, dbid = 511, nick = 'Alice') => ({
  time,
  message: `client disconnected '${nick}'(id:${String(dbid)}) reason 'reasonmsg=Verlassen'`,
});

const options = {
  zone: 'berlin' as const,
  serverId: 4,
  dryRun: false,
  now: NOW,
};

describe('importLogs', () => {
  it('writes a session per pair, with the UID from the server database', async () => {
    const path = logFile([connect('20:00:00'), disconnect('22:00:00')]);
    const report = await importLogs(database, [path], clients, options);

    expect(report).toMatchObject({
      files: 1,
      sessions: 1,
      sessionsWritten: 1,
      secondsWritten: 7200,
      usersResolved: 1,
      placeholders: 0,
    });
    const session = database.sqlite
      .prepare(
        `SELECT u.uid, s.source, s.duration FROM sessions s JOIN users u ON u.id = s.user_id`,
      )
      .get();
    expect(session).toEqual({ uid: UID_A, source: 'import', duration: 7200 });
  });

  it('counts imported time as online and unknown once the aggregates are rebuilt', async () => {
    const path = logFile([connect('20:00:00'), disconnect('22:00:00')]);
    await importLogs(database, [path], clients, options);
    // The import writes sessions only; the aggregates come from the rebuild (T8.7).
    expect(database.sqlite.prepare(`SELECT count(*) FROM user_daily_stats`).pluck().get()).toBe(0);
    rebuildAggregates(database);
    const day = berlinDay(Date.parse('2020-01-01T20:00:00+01:00') / 1000);
    expect(
      database.sqlite
        .prepare(
          `SELECT online_s AS onlineS, unknown_s AS unknownS, active_s AS activeS
           FROM user_daily_stats WHERE day = ?`,
        )
        .get(day),
    ).toEqual({ onlineS: 7200, unknownS: 7200, activeS: 0 });
  });

  it('writes nothing in a dry run but reports the same numbers', async () => {
    const path = logFile([connect('20:00:00'), disconnect('22:00:00')]);
    const report = await importLogs(database, [path], clients, { ...options, dryRun: true });
    expect(report).toMatchObject({ sessions: 1, sessionsWritten: 1, secondsWritten: 7200 });
    expect(database.sqlite.prepare(`SELECT count(*) FROM sessions`).pluck().get()).toBe(0);
    expect(database.sqlite.prepare(`SELECT count(*) FROM import_runs`).pluck().get()).toBe(0);
  });

  it('skips a file it already imported instead of counting it twice', async () => {
    const path = logFile([connect('20:00:00'), disconnect('22:00:00')]);
    await importLogs(database, [path], clients, options);
    const second = await importLogs(database, [path], clients, options);
    expect(second).toMatchObject({ files: 0, filesSkipped: 1, sessionsWritten: 0 });
    expect(database.sqlite.prepare(`SELECT count(*) FROM sessions`).pluck().get()).toBe(1);
  });

  it('creates a placeholder for a player the server database does not know', async () => {
    const path = logFile([
      connect('20:00:00', 999, 'Verschwunden'),
      disconnect('21:00:00', 999, 'Verschwunden'),
    ]);
    const report = await importLogs(database, [path], clients, options);
    expect(report).toMatchObject({ placeholders: 1, unresolvedIds: 1, sessionsWritten: 1 });
    expect(database.sqlite.prepare(`SELECT uid FROM users`).pluck().get()).toBe('unknown-dbid-999');
  });

  it('leaves out sessions that start after the switch to live tracking', async () => {
    const path = logFile([
      connect('20:00:00'),
      disconnect('21:00:00'),
      connect('23:00:00'),
      disconnect('23:30:00'),
    ]);
    const to = Date.parse('2020-01-01T22:00:00+01:00') / 1000;
    const report = await importLogs(database, [path], clients, { ...options, to });
    expect(report).toMatchObject({ sessions: 2, sessionsWritten: 1, outsideRange: 1 });
  });

  it('leaves out sessions before --from', async () => {
    const path = logFile([
      connect('08:00:00'),
      disconnect('09:00:00'),
      connect('20:00:00'),
      disconnect('21:00:00'),
    ]);
    const from = Date.parse('2020-01-01T12:00:00+01:00') / 1000;
    const report = await importLogs(database, [path], clients, { ...options, from });
    expect(report).toMatchObject({ sessionsWritten: 1, outsideRange: 1 });
  });

  it('stores hashes of the addresses, never the addresses themselves', async () => {
    const path = logFile([connect('20:00:00'), disconnect('21:00:00')]);
    const report = await importLogs(database, [path], clients, {
      ...options,
      now: Date.parse('2020-01-02T00:00:00Z') / 1000,
      ip: { hmacSecret: 'x'.repeat(32), retentionDays: 30, country: () => 'DE' },
    });
    expect(report.ipStored).toBe(1);
    const row = database.sqlite.prepare(`SELECT ip_hash AS ipHash, country FROM ip_seen`).get() as {
      ipHash: Buffer;
      country: string;
    };
    expect(row.country).toBe('DE');
    expect(row.ipHash.length).toBe(32);
    const dump = database.sqlite
      .prepare(`SELECT group_concat(uid) FROM users`)
      .pluck()
      .get() as string;
    expect(dump).not.toContain('203.0.113.7');
  });

  it('leaves out addresses that are older than the retention', async () => {
    const path = logFile([connect('20:00:00'), disconnect('21:00:00')]);
    const report = await importLogs(database, [path], clients, {
      ...options,
      now: NOW,
      ip: { hmacSecret: 'x'.repeat(32), retentionDays: 30 },
    });
    expect(report).toMatchObject({ ipStored: 0, ipTooOld: 1 });
    expect(database.sqlite.prepare(`SELECT count(*) FROM ip_seen`).pluck().get()).toBe(0);
  });

  it('closes a session that is still open when the server stops', async () => {
    const path = logFile([
      connect('20:00:00'),
      { time: '21:00:00', message: 'stopped' },
      { time: '21:30:00', message: "client disconnected 'Alice'(id:511) reason 'reasonmsg'" },
    ]);
    const report = await importLogs(database, [path], clients, options);
    expect(report.counters).toMatchObject({ closedByServer: 1, strayDisconnects: 1 });
    expect(database.sqlite.prepare(`SELECT duration FROM sessions`).pluck().get()).toBe(3600);
  });

  it('counts unknown lines without stopping', async () => {
    const path = logFile([
      { time: '19:00:00', message: 'client did something new' },
      connect('20:00:00'),
      disconnect('21:00:00'),
    ]);
    const report = await importLogs(database, [path], clients, options);
    expect(report).toMatchObject({ unparsed: 1, sessionsWritten: 1 });
  });

  it('reports progress per file', async () => {
    const first = logFile([connect('20:00:00'), disconnect('21:00:00')]);
    const second = logFile([connect('20:00:00'), disconnect('21:00:00')]);
    const seen: string[] = [];
    await importLogs(database, [first, second], clients, {
      ...options,
      onProgress: (progress) => seen.push(`${String(progress.index)}:${String(progress.lines)}`),
    });
    expect(seen).toEqual(['0:2', '1:2']);
  });
});
