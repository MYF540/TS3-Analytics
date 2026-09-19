import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { berlinDayStart } from '../../domain/time.js';
import { finalizeSegment, finalizeSession } from '../aggregates.js';
import type { AppDatabase } from '../client.js';
import {
  openSegment,
  openSession,
  recordNickname,
  recordServerMinute,
  upsertChannels,
  upsertUser,
} from '../repositories/index.js';
import { createTestDatabase } from '../testing.js';
import {
  leaderboardAllTime,
  leaderboardForDays,
  onlineSeries,
  overview,
  pickBucket,
  searchUsers,
  userDetail,
  weekdayHourHeatmap,
} from './stats.js';

const H = 3600;
const DAY1 = berlinDayStart(20260914); // Monday
const page = { limit: 10, offset: 0 };

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
  upsertChannels(database.db, [
    { id: 1, name: 'Lobby', seenAt: DAY1 },
    { id: 2, name: 'AFK', seenAt: DAY1 },
  ]);
});

afterEach(() => {
  database.close();
});

function user(uid: string, nick: string, seenAt = DAY1): number {
  const id = upsertUser(database.db, { uid, seenAt });
  recordNickname(database.db, id, nick, seenAt);
  return id;
}

function session(userId: number, joinAt: number, seconds: number, active = seconds): number {
  const sessionId = openSession(database.db, userId, joinAt);
  if (active > 0) {
    const seg = openSegment(database.db, {
      userId,
      sessionId,
      channelId: 1,
      state: 'active',
      startAt: joinAt,
    });
    finalizeSegment(database, seg, joinAt + active);
  }
  if (seconds > active) {
    const seg = openSegment(database.db, {
      userId,
      sessionId,
      channelId: 2,
      state: 'afk',
      startAt: joinAt + active,
    });
    finalizeSegment(database, seg, joinAt + seconds);
  }
  finalizeSession(database, sessionId, joinAt + seconds);
  return sessionId;
}

describe('leaderboards', () => {
  let alice: number;
  let bob: number;
  let carol: number;

  beforeEach(() => {
    alice = user('uid-alice', 'Alice');
    bob = user('uid-bob', 'Bob');
    carol = user('uid-carol', 'Carol');
    session(alice, DAY1 + 10 * H, 3 * H, H); // day 1: 3h online, 1h active
    session(bob, DAY1 + 10 * H, 2 * H); // day 1: 2h, all active
    session(bob, DAY1 + 86_400 + 10 * H, 2 * H); // day 2: 2h
    session(carol, DAY1 + 2 * 86_400 + 10 * H, 5 * H, 0); // day 3: 5h afk
  });

  it('ranks all-time online time with the current nickname', () => {
    recordNickname(database.db, bob, 'Bobby', DAY1 + 5 * 86_400);
    expect(leaderboardAllTime(database.sqlite, 'online', page)).toEqual([
      { rank: 1, userId: carol, uid: 'uid-carol', nickname: 'Carol', value: 5 * H },
      { rank: 2, userId: bob, uid: 'uid-bob', nickname: 'Bobby', value: 4 * H },
      { rank: 3, userId: alice, uid: 'uid-alice', nickname: 'Alice', value: 3 * H },
    ]);
  });

  it('ranks active time and hides users without any', () => {
    expect(
      leaderboardAllTime(database.sqlite, 'active', page).map((e) => [e.userId, e.value]),
    ).toEqual([
      [bob, 4 * H],
      [alice, H],
    ]);
  });

  it('ranks the longest session', () => {
    expect(leaderboardAllTime(database.sqlite, 'longestSession', page)[0]).toMatchObject({
      userId: carol,
      value: 5 * H,
    });
  });

  it('limits range leaderboards to the given days', () => {
    expect(
      leaderboardForDays(database.sqlite, 'online', 20260914, 20260915, page).map((e) => [
        e.userId,
        e.value,
      ]),
    ).toEqual([
      [bob, 4 * H],
      [alice, 3 * H],
    ]);
    expect(
      leaderboardForDays(database.sqlite, 'online', 20260915, 20260915, page).map((e) => e.userId),
    ).toEqual([bob]);
  });

  it('paginates with continuous ranks', () => {
    const second = leaderboardAllTime(database.sqlite, 'online', { limit: 1, offset: 1 });
    expect(second).toMatchObject([{ rank: 2, userId: bob }]);
    const range = leaderboardForDays(database.sqlite, 'online', 0, 99_999_999, {
      limit: 2,
      offset: 1,
    });
    expect(range.map((e) => [e.rank, e.userId])).toEqual([
      [2, bob],
      [3, alice],
    ]);
  });
});

describe('userDetail', () => {
  it('returns totals, nicks, sessions, daily series and top channels', () => {
    const id = user('uid-a', 'First');
    recordNickname(database.db, id, 'Second', DAY1 + 86_400);
    session(id, DAY1 + 10 * H, 3 * H, 2 * H);
    session(id, DAY1 + 86_400 + 10 * H, H);

    const detail = userDetail(database.sqlite, id, 20260915);
    expect(detail?.totals).toMatchObject({ online_s: 4 * H, active_s: 3 * H, sessions: 2 });
    expect(detail?.nicknames.map((n) => n.nick)).toEqual(['Second', 'First']);
    expect(detail?.recentSessions).toHaveLength(2);
    expect(detail?.recentSessions[0]).toMatchObject({ joinAt: DAY1 + 86_400 + 10 * H });
    expect(detail?.daily).toEqual([
      { day: 20260915, onlineS: H, activeS: H, idleS: 0, afkS: 0, unknownS: 0, sessions: 1 },
    ]);
    expect(detail?.topChannels).toEqual([
      { channelId: 1, name: 'Lobby', seconds: 3 * H },
      { channelId: 2, name: 'AFK', seconds: H },
    ]);
  });

  it('returns undefined for unknown users', () => {
    expect(userDetail(database.sqlite, 42, 0)).toBeUndefined();
  });
});

describe('overview', () => {
  it('reports online now, peaks and user counts', () => {
    const a = user('a', 'A', DAY1 - 10 * 86_400);
    const b = user('b', 'B', DAY1 + H);
    session(a, DAY1 + 10 * H, H);
    session(b, DAY1 + 10 * H + 600, 600);
    openSession(database.db, a, DAY1 + 20 * H); // still online

    expect(overview(database.sqlite, DAY1, DAY1 + 86_400)).toEqual({
      onlineNow: 1,
      peakInRange: 2,
      peakAllTime: 2,
      usersTotal: 2,
      usersNew: 1,
    });
  });
});

describe('onlineSeries', () => {
  it('picks the smallest bucket with at most 1000 points', () => {
    expect(pickBucket(0, 86_400)).toBe(300);
    expect(pickBucket(0, 30 * 86_400)).toBe(H);
    expect(pickBucket(0, 365 * 86_400)).toBe(86_400);
    expect(pickBucket(0, 6 * 365 * 86_400)).toBe(7 * 86_400);
  });

  it('uses minute data for short ranges', () => {
    for (let i = 0; i < 10; i++) recordServerMinute(database.db, DAY1 + i * 60, i);
    expect(onlineSeries(database.sqlite, DAY1, DAY1 + 600)).toEqual(
      Array.from({ length: 10 }, (_, i) => ({ t: DAY1 + i * 60, avgOnline: i, maxOnline: i })),
    );
  });

  it('aggregates hours into Berlin days for long ranges', () => {
    const a = user('a', 'A');
    session(a, DAY1 + 10 * H, 12 * H); // 12h on day 1
    session(a, DAY1 + 86_400 + 10 * H, 6 * H); // 6h on day 2
    const points = onlineSeries(database.sqlite, DAY1, DAY1 + 400 * 86_400);
    expect(points).toEqual([
      { t: DAY1, avgOnline: 0.5, maxOnline: 1 },
      { t: DAY1 + 86_400, avgOnline: 0.25, maxOnline: 1 },
    ]);
  });
});

describe('weekdayHourHeatmap', () => {
  it('maps UTC hours to Berlin weekday and hour', () => {
    const a = user('a', 'A');
    // Monday 20:00–21:00 Berlin (CEST): full hour online.
    session(a, DAY1 + 20 * H, H);
    const heatmap = weekdayHourHeatmap(database.sqlite, DAY1, DAY1 + 7 * 86_400);
    expect(heatmap).toHaveLength(7);
    expect(heatmap[0]?.[20]).toBe(1);
    expect(heatmap[0]?.[19]).toBe(0);
    expect(heatmap[1]?.[20]).toBe(0);
    expect(heatmap.flat().reduce((x, y) => x + y, 0)).toBe(1);
  });
});

describe('searchUsers', () => {
  beforeEach(() => {
    user('AbCdEf1234567890abcdefghij0=', 'HelloKitty');
    user('ZzCdEf1234567890abcdefghij0=', 'xX_Sniper_Xx');
    user('QqCdEf1234567890abcdefghij0=', '100%_real');
  });

  it('finds nicknames by substring (3+ characters)', () => {
    expect(searchUsers(database.sqlite, 'kitt').map((h) => h.nickname)).toEqual(['HelloKitty']);
    expect(searchUsers(database.sqlite, 'SNIP').map((h) => h.nickname)).toEqual(['xX_Sniper_Xx']);
  });

  it('uses a prefix match for short terms and escapes LIKE wildcards', () => {
    expect(searchUsers(database.sqlite, 'he').map((h) => h.nickname)).toEqual(['HelloKitty']);
    expect(searchUsers(database.sqlite, '1%').map((h) => h.nickname)).toEqual([]);
    expect(searchUsers(database.sqlite, '10').map((h) => h.nickname)).toEqual(['100%_real']);
  });

  it('finds users by UID prefix', () => {
    expect(searchUsers(database.sqlite, 'ZzCd').map((h) => h.nickname)).toEqual(['xX_Sniper_Xx']);
  });

  it('handles quotes and empty input safely', () => {
    expect(searchUsers(database.sqlite, '"kit')).toEqual([]);
    expect(searchUsers(database.sqlite, '   ')).toEqual([]);
  });
});
