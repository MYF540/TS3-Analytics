import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeSegment, finalizeSession } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import {
  linkUsers,
  openSegment,
  openSession,
  setSetting,
  upsertChannels,
  upsertUser,
} from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { berlinDayStart } from '../domain/time.js';
import { LEGACY_CUTOFF_KEY } from '../ranks/planner.js';
import { recordHours, RECORD_WARMUP_S } from './facts.js';
import { runAchievementJob } from './job.js';
import { loadAchievementState, saveAchievementSettings } from './settings.js';

const H = 3600;
const DAY = 86_400;
const START = berlinDayStart(20260101) + 18 * H;
const NOW = START + 40 * DAY;

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
  upsertChannels(database.db, [{ id: 1, name: 'Talk', seenAt: START }]);
});

afterEach(() => {
  database.close();
});

function player(uid: string, seenAt = START): number {
  return upsertUser(database.db, { uid, seenAt });
}

function visit(userId: number, startAt: number, seconds: number): void {
  const sessionId = openSession(database.db, userId, startAt);
  const seg = openSegment(database.db, {
    userId,
    sessionId,
    channelId: 1,
    state: 'active',
    startAt,
  });
  finalizeSegment(database, seg, startAt + seconds);
  finalizeSession(database, sessionId, startAt + seconds);
}

/** One `hours` long visit per day for `count` days. */
function daily(userId: number, count: number, hours = 1, from = START): void {
  for (let i = 0; i < count; i += 1) visit(userId, from + i * DAY, hours * H);
}

const earned = () =>
  database.sqlite
    .prepare(
      `SELECT user_id AS userId, achievement_id AS id, tier, earned_at AS earnedAt, backfilled
       FROM achievements_earned ORDER BY user_id, achievement_id, tier`,
    )
    .all() as { userId: number; id: string; tier: number; earnedAt: number; backfilled: number }[];

describe('runAchievementJob', () => {
  it('backfills history on the first run, dated as exactly as the data allows', () => {
    const a = player('a');
    daily(a, 10, 1);
    const result = runAchievementJob(database, NOW);
    expect(result.full).toBe(true);
    expect(earned()).toEqual([
      { userId: a, id: 'pioneer', tier: 1, earnedAt: START, backfilled: 1 },
      { userId: a, id: 'regular', tier: 1, earnedAt: berlinDayStart(20260110), backfilled: 1 },
      { userId: a, id: 'streak', tier: 1, earnedAt: berlinDayStart(20260107), backfilled: 1 },
    ]);
  });

  it('is idempotent and later only checks players who were online', () => {
    const a = player('a');
    const b = player('b');
    daily(a, 5);
    daily(b, 5);
    runAchievementJob(database, NOW);
    const before = earned();

    // Nothing new: no rows, and nobody was online since.
    expect(runAchievementJob(database, NOW + 60)).toMatchObject({ full: false, checked: 0 });
    expect(earned()).toEqual(before);

    // a plays on and reaches 10 h; b would too, but was not online, so b is not checked.
    visit(a, NOW + 120, 2.5 * H);
    visit(a, NOW + 3 * H, 2.5 * H);
    const second = runAchievementJob(database, NOW + 6 * H);
    expect(second).toMatchObject({ full: false, checked: 1 });
    expect(second.awarded).toEqual([
      { userId: a, achievementId: 'regular', tier: 1, earnedAt: NOW + 6 * H, backfilled: false },
    ]);
  });

  it('combines linked accounts and stores the tier for the primary account', () => {
    const main = player('main');
    const alt = player('alt');
    daily(main, 3, 2); // 6 h
    daily(alt, 3, 2, START + 3 * DAY); // 6 h more, and the streak continues
    linkUsers(database.sqlite, main, alt, 'admin', NOW);
    runAchievementJob(database, NOW);
    const regular = earned().filter((e) => e.id === 'regular');
    expect(regular).toEqual([
      { userId: main, id: 'regular', tier: 1, earnedAt: berlinDayStart(20260105), backfilled: 1 },
    ]);
  });

  it('does not award a tier again that another account of the person already holds', () => {
    const main = player('main');
    const alt = player('alt');
    daily(alt, 10);
    runAchievementJob(database, NOW);
    expect(
      earned()
        .filter((e) => e.id === 'regular')
        .map((e) => e.userId),
    ).toEqual([alt]);
    // After linking, `main` is primary; the tier stays with `alt` and is not duplicated.
    linkUsers(database.sqlite, main, alt, 'admin', NOW);
    runAchievementJob(database, NOW + 60);
    expect(
      earned()
        .filter((e) => e.id === 'regular')
        .map((e) => e.userId),
    ).toEqual([alt]);
  });

  it('counts legacy time from the cutoff, but no imported time', () => {
    const a = player('a');
    const cutoff = START - 10 * DAY;
    setSetting(database.db, LEGACY_CUTOFF_KEY, cutoff, cutoff);
    database.sqlite.prepare('UPDATE users SET legacy_seconds = ? WHERE id = ?').run(100 * H, a);
    visit(a, START, H);
    runAchievementJob(database, NOW);
    const regular = earned().filter((e) => e.id === 'regular');
    expect(regular.map((e) => [e.tier, e.earnedAt])).toEqual([
      [1, cutoff],
      [2, cutoff],
    ]);
    expect(earned().some((e) => e.id === 'legacy')).toBe(true);
  });

  it('leaves out disabled achievements and checks everybody again after a change', () => {
    const a = player('a');
    daily(a, 10);
    saveAchievementSettings(database.db, { disabled: ['streak', 'pioneer'] }, NOW);
    runAchievementJob(database, NOW);
    expect(earned().map((e) => e.id)).toEqual(['regular']);

    saveAchievementSettings(database.db, { disabled: ['pioneer'] }, NOW);
    const result = runAchievementJob(database, NOW + 60);
    expect(result.full).toBe(true);
    // Switched on later: found in the history, so it is backfilled and never announced.
    expect(earned().find((e) => e.id === 'streak')).toMatchObject({
      earnedAt: berlinDayStart(20260107),
      backfilled: 1,
    });
  });

  it('never awards hidden players (anonymized, unknown database ids)', () => {
    const a = player('a');
    const ghost = player('unknown-dbid-7');
    daily(a, 10);
    daily(ghost, 10);
    database.sqlite.prepare('UPDATE users SET anonymized_at = ? WHERE id = ?').run(NOW, a);
    runAchievementJob(database, NOW);
    expect(earned()).toEqual([]);
  });

  it('stores what it did', () => {
    player('a');
    runAchievementJob(database, NOW);
    expect(loadAchievementState(database.db)).toMatchObject({
      lastRun: NOW,
      full: true,
      checked: 1,
    });
  });

  it('awards the record night only after the warm-up of the data', () => {
    const a = player('a');
    visit(a, START + RECORD_WARMUP_S + H + 60, H);
    const insert = database.sqlite.prepare(
      'INSERT OR REPLACE INTO server_hourly (hour, online_s, max_online, unique_users) VALUES (?, 0, ?, ?)',
    );
    insert.run(START, 3, 3);
    insert.run(START + H, 5, 5);
    insert.run(START + RECORD_WARMUP_S, 4, 4);
    insert.run(START + RECORD_WARMUP_S + H, 6, 6);
    expect(recordHours(database.sqlite)).toEqual([START + RECORD_WARMUP_S + H]);

    runAchievementJob(database, NOW);
    expect(earned().find((e) => e.id === 'record-night')?.earnedAt).toBe(
      START + RECORD_WARMUP_S + H,
    );
  });
});
