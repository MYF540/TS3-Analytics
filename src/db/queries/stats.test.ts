import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { berlinDayStart } from '../../domain/time.js';
import { finalizeSegment, finalizeSession } from '../aggregates.js';
import type { AppDatabase } from '../client.js';
import {
  linkUsers,
  openSegment,
  openSession,
  recordNickname,
  recordServerMinute,
  setPrimaryUser,
  upsertChannels,
  upsertUser,
} from '../repositories/index.js';
import { createTestDatabase } from '../testing.js';
import {
  countLeaderboardAllTime,
  countLeaderboardForDays,
  leaderboardAllTime,
  listUsers,
  leaderboardForDays,
  onlineSeries,
  overview,
  pickBucket,
  searchUsers,
  userDetail,
  userWeekdayHourHeatmap,
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
      { rank: 1, userId: carol, uid: 'uid-carol', nickname: 'Carol', value: 5 * H, accounts: 1 },
      { rank: 2, userId: bob, uid: 'uid-bob', nickname: 'Bobby', value: 4 * H, accounts: 1 },
      { rank: 3, userId: alice, uid: 'uid-alice', nickname: 'Alice', value: 3 * H, accounts: 1 },
    ]);
  });

  it('counts linked UIDs as one person under the primary user (T5.3)', () => {
    linkUsers(database.sqlite, alice, bob, 'test', DAY1);
    expect(leaderboardAllTime(database.sqlite, 'online', page)).toEqual([
      { rank: 1, userId: alice, uid: 'uid-alice', nickname: 'Alice', value: 7 * H, accounts: 2 },
      { rank: 2, userId: carol, uid: 'uid-carol', nickname: 'Carol', value: 5 * H, accounts: 1 },
    ]);
    expect(countLeaderboardAllTime(database.sqlite, 'online')).toBe(2);
    expect(
      leaderboardForDays(database.sqlite, 'online', 20260914, 20260915, page).map((e) => [
        e.userId,
        e.value,
        e.accounts,
      ]),
    ).toEqual([[alice, 7 * H, 2]]);
    expect(countLeaderboardForDays(database.sqlite, 'online', 20260914, 20260915)).toBe(1);
    // The longest session is the maximum, not the sum.
    expect(
      leaderboardAllTime(database.sqlite, 'longestSession', page).map((e) => [e.userId, e.value]),
    ).toEqual([
      [carol, 5 * H],
      [alice, 3 * H],
    ]);

    // Either UID shows the figures of the whole person.
    const detail = userDetail(database.sqlite, bob, 20260901);
    expect(detail?.totals).toMatchObject({ online_s: 7 * H, sessions: 3 });
    expect(detail?.daily.map((d) => [d.day, d.onlineS])).toEqual([
      [20260914, 5 * H],
      [20260915, 2 * H],
    ]);

    setPrimaryUser(database.sqlite, bob);
    expect(leaderboardAllTime(database.sqlite, 'online', page)[0]).toMatchObject({
      userId: bob,
      value: 7 * H,
    });
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

  it('counts ranked users for pagination', () => {
    expect(countLeaderboardAllTime(database.sqlite, 'online')).toBe(3);
    expect(countLeaderboardAllTime(database.sqlite, 'active')).toBe(2);
    expect(countLeaderboardForDays(database.sqlite, 'online', 20260915, 20260916)).toBe(2);
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

describe('listUsers', () => {
  let ids: Record<string, number>;
  beforeEach(() => {
    ids = {
      alice: user('uid-alice', 'Alice', DAY1),
      bob: user('uid-bob', 'bob', DAY1 + H),
      carol: user('uid-carol', 'Carol', DAY1 + 2 * H),
      casual: user('uid-casual', 'Casual', DAY1 + 3 * H),
    };
    session(ids.alice ?? 0, DAY1 + 10 * H, 5 * H, 2 * H);
    session(ids.bob ?? 0, DAY1 + 10 * H, 3 * H);
    session(ids.carol ?? 0, DAY1 + 10 * H, 2 * H, 0);
    session(ids.casual ?? 0, DAY1 + 10 * H, 600);
    openSession(database.db, ids.bob ?? 0, DAY1 + 20 * H);
  });
  const base = { sort: 'online', order: 'desc', limit: 10, offset: 0, minOnlineS: 3600 } as const;

  it('hides casual users by default and sorts by online time', () => {
    const { items, total } = listUsers(database.sqlite, base);
    expect(total).toBe(3);
    expect(items.map((i) => [i.nickname, i.onlineS, i.online])).toEqual([
      ['Alice', 5 * H, false],
      ['bob', 3 * H, true],
      ['Carol', 2 * H, false],
    ]);
  });

  it('shows casual users on request', () => {
    expect(listUsers(database.sqlite, { ...base, minOnlineS: 0 }).total).toBe(4);
  });

  it('sorts by other columns in both directions', () => {
    const names = (
      sort: (typeof base)['sort'] | 'nickname' | 'active' | 'firstSeen',
      order: 'asc' | 'desc',
    ) => listUsers(database.sqlite, { ...base, sort, order }).items.map((i) => i.nickname);
    expect(names('nickname', 'asc')).toEqual(['Alice', 'bob', 'Carol']);
    expect(names('active', 'desc')).toEqual(['bob', 'Alice', 'Carol']);
    expect(names('firstSeen', 'asc')).toEqual(['Alice', 'bob', 'Carol']);
  });

  it('paginates and reports the total', () => {
    const page = listUsers(database.sqlite, { ...base, limit: 2, offset: 2 });
    expect(page.total).toBe(3);
    expect(page.items.map((i) => i.nickname)).toEqual(['Carol']);
  });

  it('searches nicknames and UIDs', () => {
    expect(
      listUsers(database.sqlite, { ...base, search: 'aro' }).items.map((i) => i.nickname),
    ).toEqual(['Carol']);
    expect(
      listUsers(database.sqlite, { ...base, search: 'uid-b' }).items.map((i) => i.nickname),
    ).toEqual(['bob']);
    expect(listUsers(database.sqlite, { ...base, search: 'cas' }).total).toBe(0); // casual hidden
  });
});

describe('hidden players', () => {
  /** Placeholders of the log import (T8.3) and anonymized players (T7.2) stay out of sight. */
  it('leaves placeholders and anonymized players out of lists, search and leaderboards', () => {
    const alice = user('uid-alice', 'Alice', DAY1);
    const ghost = user('unknown-dbid-4711', 'Geist', DAY1);
    const gone = user('uid-gone', 'Weg', DAY1);
    session(alice, DAY1 + 10 * H, 3 * H);
    session(ghost, DAY1 + 10 * H, 9 * H);
    session(gone, DAY1 + 10 * H, 8 * H);
    database.sqlite.prepare(`UPDATE users SET anonymized_at = ? WHERE id = ?`).run(DAY1, gone);

    expect(leaderboardAllTime(database.sqlite, 'online', page).map((e) => e.nickname)).toEqual([
      'Alice',
    ]);
    const list = listUsers(database.sqlite, {
      sort: 'online',
      order: 'desc',
      limit: 10,
      offset: 0,
      minOnlineS: 0,
    });
    expect(list.items.map((i) => i.nickname)).toEqual(['Alice']);
    expect(searchUsers(database.sqlite, 'Geist')).toEqual([]);
  });

  it('keeps their time in the server statistics', () => {
    const ghost = user('unknown-dbid-4711', 'Geist', DAY1);
    session(ghost, DAY1 + 10 * H, 2 * H);
    expect(
      database.sqlite.prepare(`SELECT sum(online_s) FROM user_daily_stats`).pluck().get(),
    ).toBe(2 * H);
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
    expect(detail?.openSession).toBeUndefined();
    expect(detail?.countries).toEqual([]);
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

    recordServerMinute(database.db, DAY1 + 21 * H, 3); // live sample, higher than any closed hour
    expect(overview(database.sqlite, DAY1, DAY1 + 86_400, DAY1)).toEqual({
      onlineNow: 1,
      peakToday: 3,
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
    expect(onlineSeries(database.sqlite, DAY1, DAY1 + 600)).toEqual({
      resolution: 60,
      points: Array.from({ length: 10 }, (_, i) => ({
        t: DAY1 + i * 60,
        avgOnline: i,
        maxOnline: i,
      })),
    });
  });

  it('falls back to hourly data where no minute samples exist', () => {
    const a = user('a', 'A');
    session(a, DAY1 + 10 * H, H);
    recordServerMinute(database.db, DAY1 + 5 * 86_400, 1); // minute data starts later
    const { resolution, points } = onlineSeries(database.sqlite, DAY1, DAY1 + 86_400);
    expect(resolution).toBe(H);
    expect(points).toHaveLength(24);
    expect(points[10]).toEqual({ t: DAY1 + 10 * H, avgOnline: 1, maxOnline: 1 });
  });

  it('fills hours without sessions with zeros', () => {
    const a = user('a', 'A');
    session(a, DAY1 + 2 * H, H);
    session(a, DAY1 + 5 * H, H);
    const { points } = onlineSeries(database.sqlite, DAY1 + 30 * 60, DAY1 + 8 * H);
    expect(points.map((p) => [(p.t - DAY1) / H, p.maxOnline])).toEqual([
      [0, 0],
      [1, 0],
      [2, 1],
      [3, 0],
      [4, 0],
      [5, 1],
      [6, 0],
      [7, 0],
    ]);
  });

  it('uses the real length of weeks with a DST change', () => {
    const a = user('a', 'A');
    const week = berlinDayStart(20261019); // Monday; the week contains the switch back to CET
    session(a, week, 169 * H); // online the whole (169 h) week
    const { resolution, points } = onlineSeries(database.sqlite, week, week + 6 * 365 * 86_400);
    expect(resolution).toBe(7 * 86_400);
    expect(points[0]).toEqual({ t: week, avgOnline: 1, maxOnline: 1 });
  });

  it('aggregates hours into Berlin days for long ranges', () => {
    const a = user('a', 'A');
    session(a, DAY1 + 10 * H, 12 * H); // 12h on day 1
    session(a, DAY1 + 86_400 + 10 * H, 6 * H); // 6h on day 2
    const { points, resolution } = onlineSeries(database.sqlite, DAY1, DAY1 + 400 * 86_400);
    expect(resolution).toBe(86_400);
    expect(points.slice(0, 3)).toEqual([
      { t: DAY1, avgOnline: 0.5, maxOnline: 1 },
      { t: DAY1 + 86_400, avgOnline: 0.25, maxOnline: 1 },
      { t: DAY1 + 2 * 86_400, avgOnline: 0, maxOnline: 0 },
    ]);
    expect(points).toHaveLength(400);
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

describe('userWeekdayHourHeatmap', () => {
  const week = 7 * 86_400;

  it('reports the share of each weekday hour the player was online', () => {
    const a = user('a', 'A');
    // Monday 20:00–22:00 Berlin, on two of four weeks.
    session(a, DAY1 + 20 * H, 2 * H);
    session(a, DAY1 + 2 * week + 20 * H, 2 * H);
    const heatmap = userWeekdayHourHeatmap(database.sqlite, a, DAY1, DAY1 + 4 * week);
    expect(heatmap).toHaveLength(7);
    expect(heatmap[0]?.[20]).toBe(50);
    expect(heatmap[0]?.[21]).toBe(50);
    expect(heatmap[0]?.[19]).toBe(0);
    expect(heatmap[1]?.[20]).toBe(0);
  });

  it('counts a part of an hour proportionally', () => {
    const a = user('a', 'A');
    session(a, DAY1 + 20 * H, 15 * 60); // a quarter of the 20:00 hour, one week in the window
    expect(userWeekdayHourHeatmap(database.sqlite, a, DAY1, DAY1 + week)[0]?.[20]).toBe(25);
  });

  it('splits a session that runs over midnight', () => {
    const a = user('a', 'A');
    session(a, DAY1 + 23 * H, 2 * H); // Monday 23:00 to Tuesday 01:00
    const heatmap = userWeekdayHourHeatmap(database.sqlite, a, DAY1, DAY1 + week);
    expect(heatmap[0]?.[23]).toBe(100);
    expect(heatmap[1]?.[0]).toBe(100);
    expect(heatmap[1]?.[1]).toBe(0);
  });

  it('counts all accounts of a person (T5.3)', () => {
    const a = user('a', 'A');
    const b = user('b', 'B');
    linkUsers(database.sqlite, a, b, 'test', DAY1);
    session(b, DAY1 + 10 * H, H);
    expect(userWeekdayHourHeatmap(database.sqlite, a, DAY1, DAY1 + week)[0]?.[10]).toBe(100);
  });

  it('never exceeds 100 percent when two linked accounts overlap', () => {
    const a = user('a', 'A');
    const b = user('b', 'B');
    linkUsers(database.sqlite, a, b, 'test', DAY1);
    session(a, DAY1 + 10 * H, H);
    session(b, DAY1 + 10 * H, H);
    expect(userWeekdayHourHeatmap(database.sqlite, a, DAY1, DAY1 + week)[0]?.[10]).toBe(100);
  });

  it('is empty without sessions', () => {
    const a = user('a', 'A');
    const heatmap = userWeekdayHourHeatmap(database.sqlite, a, DAY1, DAY1 + week);
    expect(heatmap.flat().every((value) => value === 0)).toBe(true);
  });

  it('ignores time outside the window', () => {
    const a = user('a', 'A');
    session(a, DAY1 - 2 * H, 4 * H); // starts before the window and reaches into it
    const heatmap = userWeekdayHourHeatmap(database.sqlite, a, DAY1, DAY1 + week);
    expect(heatmap[0]?.[0]).toBe(100);
    expect(heatmap[0]?.[1]).toBe(100);
    expect(heatmap[0]?.[2]).toBe(0);
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
