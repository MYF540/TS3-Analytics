import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  finalizeSession,
  PrunedRangeError,
  rebuildAggregates,
  recordClosedSegment,
  segmentsPrunedBefore,
} from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import {
  openSegment,
  openSession,
  recordServerMinute,
  upsertIpSeen,
  upsertUser,
} from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { berlinDay } from '../domain/time.js';
import { createSilentLogger } from '../logging/logger.js';
import { monthsBefore, runMaintenance, runRetention } from './retention.js';
import { JobRunner } from './runner.js';

const DAY = 86_400;
const NOW = Date.parse('2026-09-19T12:00:00Z') / 1000;

let database: AppDatabase;
const rows = (sql: string) => database.sqlite.prepare(sql).all();
const aggregates = () => ({
  daily: rows('SELECT * FROM user_daily_stats ORDER BY user_id, day'),
  totals: rows('SELECT * FROM user_totals ORDER BY user_id'),
  hourly: rows('SELECT * FROM server_hourly ORDER BY hour'),
});

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

/** A user with one closed session and segments at `start`. */
function history(uid: string, start: number, seconds: number): number {
  const userId = upsertUser(database.db, { uid, seenAt: start });
  const sessionId = openSession(database.db, userId, start);
  recordClosedSegment(database, {
    userId,
    sessionId,
    channelId: null,
    state: 'active',
    startAt: start,
    endAt: start + seconds / 2,
  });
  recordClosedSegment(database, {
    userId,
    sessionId,
    channelId: null,
    state: 'idle',
    startAt: start + seconds / 2,
    endAt: start + seconds,
  });
  finalizeSession(database, sessionId, start + seconds);
  return userId;
}

const hash = (v: string) => createHmac('sha256', 'k').update(v).digest();

describe('runRetention', () => {
  it('deletes old ip_seen rows and keeps recent ones', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: NOW });
    const sighting = { userId, subnetHash: hash('n'), country: null };
    upsertIpSeen(database.db, { ...sighting, ipHash: hash('old'), seenAt: NOW - 91 * DAY });
    upsertIpSeen(database.db, { ...sighting, ipHash: hash('edge'), seenAt: NOW - 89 * DAY });
    upsertIpSeen(database.db, { ...sighting, ipHash: hash('new'), seenAt: NOW - DAY });

    const result = runRetention(database, { ipRetentionDays: 90, segmentRetentionMonths: 0 }, NOW);
    expect(result.ipSeen).toBe(1);
    expect(rows('SELECT count(*) AS n FROM ip_seen')).toEqual([{ n: 2 }]);
  });

  it('deletes server_minutely older than 14 days in batches', () => {
    const insert = database.sqlite.prepare(
      'INSERT INTO server_minutely (ts, online) VALUES (?, 1)',
    );
    database.sqlite.transaction(() => {
      for (let i = 0; i < 25_000; i++) insert.run(NOW - 30 * DAY + i * 60);
    })();
    recordServerMinute(database.db, NOW - 60, 5);

    const result = runRetention(database, { ipRetentionDays: 90, segmentRetentionMonths: 0 }, NOW);
    const remaining = rows('SELECT min(ts) AS first, count(*) AS n FROM server_minutely')[0] as {
      first: number;
      n: number;
    };
    expect(result.serverMinutely).toBe(16 * 1440); // more than one batch of 10 000
    expect(remaining.first).toBeGreaterThanOrEqual(NOW - 14 * DAY);
    expect(remaining.n).toBeGreaterThan(1);
  });

  it('keeps activity segments by default', () => {
    history('u', NOW - 800 * DAY, 3600);
    const result = runRetention(database, { ipRetentionDays: 90, segmentRetentionMonths: 0 }, NOW);
    expect(result.segments).toBe(0);
    expect(rows('SELECT count(*) AS n FROM activity_segments')).toEqual([{ n: 2 }]);
    expect(segmentsPrunedBefore(database.db)).toBeUndefined();
  });

  it('deletes old closed segments without changing any aggregate', () => {
    history('old', NOW - 400 * DAY, 7200);
    history('new', NOW - 10 * DAY, 3600);
    const userId = upsertUser(database.db, { uid: 'open', seenAt: NOW - 400 * DAY });
    openSegment(database.db, {
      userId,
      sessionId: openSession(database.db, userId, NOW - 400 * DAY),
      channelId: null,
      state: 'active',
      startAt: NOW - 400 * DAY,
    });
    const before = aggregates();

    const result = runRetention(database, { ipRetentionDays: 90, segmentRetentionMonths: 12 }, NOW);

    expect(result.segments).toBe(2);
    expect(rows('SELECT count(*) AS n FROM activity_segments')).toEqual([{ n: 3 }]); // 2 new + open
    expect(aggregates()).toEqual(before);
    expect(segmentsPrunedBefore(database.db)).toBe(monthsBefore(NOW, 12));
  });
});

describe('rebuild after pruning', () => {
  it('refuses to rebuild pruned days unless explicitly allowed', () => {
    history('old', NOW - 400 * DAY, 7200);
    history('new', NOW - 10 * DAY, 3600);
    runRetention(database, { ipRetentionDays: 90, segmentRetentionMonths: 12 }, NOW);
    const before = aggregates();

    expect(() => rebuildAggregates(database)).toThrow(PrunedRangeError);
    expect(() => rebuildAggregates(database, { fromDay: berlinDay(NOW - 400 * DAY) })).toThrow(
      PrunedRangeError,
    );

    // Starting after the pruned period is fine and leaves the old aggregates alone.
    rebuildAggregates(database, { fromDay: berlinDay(NOW - 30 * DAY) });
    expect(aggregates().daily).toEqual(before.daily);

    // Forcing it shows why the guard exists: activity of the pruned day is lost.
    rebuildAggregates(database, { allowPrunedRange: true });
    const oldDay = rows(
      `SELECT active_s FROM user_daily_stats d JOIN users u ON u.id = d.user_id WHERE u.uid = 'old'`,
    );
    expect(oldDay).toEqual([{ active_s: 0 }]);
  });
});

describe('monthsBefore', () => {
  it('subtracts calendar months', () => {
    expect(monthsBefore(Date.parse('2026-09-19T12:00:00Z') / 1000, 12)).toBe(
      Date.parse('2025-09-19T12:00:00Z') / 1000,
    );
  });
});

describe('runMaintenance', () => {
  it('runs optimize and a WAL checkpoint', () => {
    const pragma = vi.spyOn(database.sqlite, 'pragma');
    runMaintenance(database.sqlite);
    expect(pragma.mock.calls.map((c) => c[0])).toEqual(['optimize', 'wal_checkpoint(TRUNCATE)']);
  });
});

describe('JobRunner', () => {
  it('runs due jobs, remembers the last run and survives failures', () => {
    let now = NOW;
    const calls: string[] = [];
    const jobs = [
      { name: 'daily', intervalS: DAY, run: () => calls.push('daily') },
      {
        name: 'broken',
        intervalS: DAY,
        run: () => {
          throw new Error('boom');
        },
      },
    ];
    const runner = new JobRunner(jobs, {
      db: database.db,
      logger: createSilentLogger(),
      now: () => now,
    });

    expect(runner.runDue()).toEqual(['daily', 'broken']);
    now += DAY - 1;
    expect(runner.runDue()).toEqual([]);
    now += 1;
    expect(runner.runDue()).toEqual(['daily', 'broken']);
    expect(calls).toEqual(['daily', 'daily']);

    // A new runner (restart) continues from the stored last run.
    const restarted = new JobRunner(jobs, {
      db: database.db,
      logger: createSilentLogger(),
      now: () => now + 60,
    });
    expect(restarted.runDue()).toEqual([]);
    expect(restarted.lastRun('daily')).toBe(now);
  });
});
