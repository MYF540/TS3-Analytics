import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACTIVITY_STATES } from './schema.js';
import { finalizeSegment, finalizeSession, rebuildAggregates } from './aggregates.js';
import type { AppDatabase } from './client.js';
import { openSegment, openSession, upsertUser } from './repositories/index.js';
import { createTestDatabase } from './testing.js';

const utc = (iso: string) => Date.parse(iso) / 1000;
const H = 3600;

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

function snapshot() {
  const all = (sql: string) => database.sqlite.prepare(sql).all();
  return {
    daily: all('SELECT * FROM user_daily_stats ORDER BY user_id, day'),
    totals: all('SELECT * FROM user_totals ORDER BY user_id'),
    hourly: all('SELECT * FROM server_hourly ORDER BY hour'),
  };
}

/** Small deterministic PRNG so the scenario is random-looking but reproducible. */
function prng(seed: number) {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

interface PendingClose {
  kind: 'session' | 'segment';
  id: number;
  at: number;
}

/**
 * Creates sessions with activity segments around both 2026 DST switches and several midnights,
 * including imported, zero-length and overlapping sessions. Returns the closes to perform.
 */
function seedScenario(seed: number): PendingClose[] {
  const random = prng(seed);
  const db = database.db;
  const closes: PendingClose[] = [];
  const windows = [
    utc('2026-03-28T18:00:00Z'), // spring forward (23h day)
    utc('2026-10-24T18:00:00Z'), // fall back (25h day)
    utc('2026-09-18T19:00:00Z'), // ordinary midnight
  ];
  const userIds = Array.from({ length: 6 }, (_, i) =>
    upsertUser(db, { uid: `uid-${String(i)}`, seenAt: windows[0] ?? 0 }),
  );

  for (const windowStart of windows) {
    for (const userId of userIds) {
      let t = windowStart + Math.floor(random() * 2 * H);
      for (let s = 0; s < 3; s++) {
        const source = random() < 0.2 ? 'import' : 'live';
        const length = random() < 0.1 ? 0 : Math.floor(random() * 10 * H);
        const sessionId = openSession(db, userId, t, source);
        closes.push({ kind: 'session', id: sessionId, at: t + length });

        if (source === 'live') {
          let segStart = t;
          while (segStart < t + length) {
            const segEnd = Math.min(t + length, segStart + 60 + Math.floor(random() * 3 * H));
            const state =
              ACTIVITY_STATES[Math.floor(random() * ACTIVITY_STATES.length)] ?? 'active';
            const segmentId = openSegment(db, {
              userId,
              sessionId,
              channelId: null,
              state,
              startAt: segStart,
            });
            closes.push({ kind: 'segment', id: segmentId, at: segEnd });
            segStart = segEnd;
          }
        }
        // Sometimes overlap the next session (e.g. second client with the same identity).
        t += length + (random() < 0.2 ? -Math.floor(length / 2) : Math.floor(random() * 3 * H));
      }
    }
  }
  // Close in a shuffled order to prove the result does not depend on it.
  for (let i = closes.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [closes[i], closes[j]] = [closes[j] as PendingClose, closes[i] as PendingClose];
  }
  return closes;
}

function closeAll(closes: PendingClose[]) {
  for (const close of closes) {
    if (close.kind === 'session') finalizeSession(database, close.id, close.at);
    else finalizeSegment(database, close.id, close.at);
  }
}

describe('incremental aggregation', () => {
  it('splits a session over midnight into both Berlin days', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: 0 });
    const joinAt = utc('2026-09-18T21:00:00Z'); // 23:00 CEST
    const sessionId = openSession(database.db, userId, joinAt);
    finalizeSession(database, sessionId, joinAt + 2 * H);

    const { daily, totals } = snapshot();
    expect(daily).toMatchObject([
      { day: 20260918, online_s: H, sessions: 1, longest_session_s: 2 * H },
      { day: 20260919, online_s: H, sessions: 0, longest_session_s: 0 },
    ]);
    expect(totals).toMatchObject([
      { online_s: 2 * H, sessions: 1, first_seen: joinAt, last_seen: joinAt + 2 * H },
    ]);
  });

  it('counts the full 25 hours of the autumn DST day', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: 0 });
    const joinAt = utc('2026-10-24T22:00:00Z'); // 00:00 CEST on 2026-10-25
    const sessionId = openSession(database.db, userId, joinAt);
    finalizeSession(database, sessionId, utc('2026-10-25T23:00:00Z')); // 00:00 CET next day
    expect(snapshot().daily).toMatchObject([{ day: 20261025, online_s: 25 * H }]);
  });

  it('adds segment time to the state columns and active time to the totals', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: 0 });
    const t = utc('2026-09-19T08:00:00Z');
    const sessionId = openSession(database.db, userId, t);
    const a = openSegment(database.db, {
      userId,
      sessionId,
      channelId: null,
      state: 'active',
      startAt: t,
    });
    finalizeSegment(database, a, t + 600);
    const b = openSegment(database.db, {
      userId,
      sessionId,
      channelId: null,
      state: 'idle',
      startAt: t + 600,
    });
    finalizeSegment(database, b, t + 900);
    finalizeSession(database, sessionId, t + 900);

    expect(snapshot().daily).toMatchObject([
      { online_s: 900, active_s: 600, idle_s: 300, afk_s: 0, unknown_s: 0, sessions: 1 },
    ]);
    expect(snapshot().totals).toMatchObject([{ online_s: 900, active_s: 600 }]);
  });

  it('never counts a session twice', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: 0 });
    const t = utc('2026-09-19T08:00:00Z');
    const sessionId = openSession(database.db, userId, t);
    expect(finalizeSession(database, sessionId, t + 100)).toBeDefined();
    expect(finalizeSession(database, sessionId, t + 200)).toBeUndefined();
    expect(snapshot().totals).toMatchObject([{ online_s: 100, sessions: 1 }]);
  });

  it('maintains server_hourly from closed sessions', () => {
    const a = upsertUser(database.db, { uid: 'a', seenAt: 0 });
    const b = upsertUser(database.db, { uid: 'b', seenAt: 0 });
    const t = utc('2026-09-19T08:00:00Z');
    const sa = openSession(database.db, a, t);
    const sb = openSession(database.db, b, t + 1800);
    finalizeSession(database, sa, t + H + 600);
    finalizeSession(database, sb, t + 2400);
    expect(snapshot().hourly).toEqual([
      { hour: t, online_s: H + 600, max_online: 2, unique_users: 2 },
      { hour: t + H, online_s: 600, max_online: 1, unique_users: 1 },
    ]);
  });
});

describe('rebuildAggregates', () => {
  it.each([1, 2, 3])('matches incremental aggregation exactly (seed %i)', (seed) => {
    closeAll(seedScenario(seed));
    const incremental = snapshot();
    expect(incremental.daily.length).toBeGreaterThan(10);
    expect(incremental.hourly.length).toBeGreaterThan(10);

    database.sqlite.exec('DELETE FROM user_daily_stats; DELETE FROM user_totals;');
    database.sqlite.exec('DELETE FROM server_hourly;');
    rebuildAggregates(database);
    expect(snapshot()).toEqual(incremental);
  });

  it('repairs corrupted aggregates within a day range and leaves other days alone', () => {
    closeAll(seedScenario(7));
    const incremental = snapshot();

    database.sqlite.exec(`
      UPDATE user_daily_stats SET online_s = 1, active_s = 999 WHERE day = 20261025;
      UPDATE user_totals SET online_s = 0, sessions = 0;
      UPDATE server_hourly SET max_online = 99;`);
    const result = rebuildAggregates(database, { fromDay: 20261024, toDay: 20261026 });

    const after = snapshot();
    expect(result.users).toBe(6);
    expect(after.daily).toEqual(incremental.daily);
    expect(after.totals).toEqual(incremental.totals);
    const from = Date.parse('2026-10-23T22:00:00Z') / 1000;
    const to = Date.parse('2026-10-26T23:00:00Z') / 1000;
    const inRange = (rows: unknown[]) =>
      (rows as { hour: number }[]).filter((r) => r.hour >= from && r.hour < to);
    expect(inRange(after.hourly)).toEqual(inRange(incremental.hourly));
    const outside = (after.hourly as { hour: number; max_online: number }[]).filter(
      (r) => r.hour < from || r.hour >= to,
    );
    expect(outside.every((r) => r.max_online === 99)).toBe(true);
  });

  it('ignores open sessions and segments', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: 0 });
    openSession(database.db, userId, utc('2026-09-19T08:00:00Z'));
    expect(rebuildAggregates(database)).toEqual({ users: 0, dailyRows: 0, hours: 0 });
    expect(snapshot()).toEqual({ daily: [], totals: [], hourly: [] });
  });

  it('removes aggregates whose source rows no longer exist', () => {
    const userId = upsertUser(database.db, { uid: 'u', seenAt: 0 });
    const t = utc('2026-09-19T08:00:00Z');
    finalizeSession(database, openSession(database.db, userId, t), t + 60);
    database.sqlite.exec('DELETE FROM sessions');
    rebuildAggregates(database);
    expect(snapshot()).toEqual({ daily: [], totals: [], hourly: [] });
  });
});
