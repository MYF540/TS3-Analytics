import { describe, expect, it } from 'vitest';
import {
  aggregateHours,
  emptyDelta,
  segmentDailyDeltas,
  sessionDailyDeltas,
  type SessionSpan,
} from './aggregation.js';

const utc = (iso: string) => Date.parse(iso) / 1000;
const H = 3600;

describe('sessionDailyDeltas', () => {
  it('counts a session and its duration on its start day', () => {
    const joinAt = utc('2026-09-19T08:00:00Z');
    expect(sessionDailyDeltas({ joinAt, leaveAt: joinAt + 2 * H, source: 'live' })).toEqual([
      { ...emptyDelta(20260919), onlineS: 2 * H, sessions: 1, longestSessionS: 2 * H },
    ]);
  });

  it('splits online time across midnight but keeps session count on the join day', () => {
    // 23:00 CEST → 01:00 CEST
    const joinAt = utc('2026-09-18T21:00:00Z');
    expect(sessionDailyDeltas({ joinAt, leaveAt: joinAt + 2 * H, source: 'live' })).toEqual([
      { ...emptyDelta(20260918), onlineS: H, sessions: 1, longestSessionS: 2 * H },
      { ...emptyDelta(20260919), onlineS: H },
    ]);
  });

  it('counts imported time also as unknown activity', () => {
    const joinAt = utc('2026-09-19T08:00:00Z');
    expect(sessionDailyDeltas({ joinAt, leaveAt: joinAt + H, source: 'import' })).toEqual([
      { ...emptyDelta(20260919), onlineS: H, unknownS: H, sessions: 1, longestSessionS: H },
    ]);
  });

  it('still counts a zero-length session', () => {
    const joinAt = utc('2026-09-19T08:00:00Z');
    expect(sessionDailyDeltas({ joinAt, leaveAt: joinAt, source: 'live' })).toEqual([
      { ...emptyDelta(20260919), sessions: 1 },
    ]);
  });
});

describe('segmentDailyDeltas', () => {
  it('adds time to the column of the segment state, split by day', () => {
    const startAt = utc('2026-09-18T21:30:00Z');
    expect(segmentDailyDeltas({ startAt, endAt: startAt + H, state: 'afk' })).toEqual([
      { ...emptyDelta(20260918), afkS: 1800 },
      { ...emptyDelta(20260919), afkS: 1800 },
    ]);
  });
});

describe('aggregateHours', () => {
  const base = utc('2026-09-19T10:00:00Z');

  it('computes online seconds, peak concurrency and unique users per hour', () => {
    const sessions: SessionSpan[] = [
      { userId: 1, joinAt: base, leaveAt: base + 1800 },
      { userId: 2, joinAt: base + 900, leaveAt: base + 2700 },
      { userId: 1, joinAt: base + 2700, leaveAt: base + H + 600 }, // same user again
    ];
    expect([...aggregateHours(sessions, base, base + 2 * H)]).toEqual([
      { hour: base, onlineS: 1800 + 1800 + 900, maxOnline: 2, uniqueUsers: 2 },
      { hour: base + H, onlineS: 600, maxOnline: 1, uniqueUsers: 1 },
    ]);
  });

  it('treats sessions as half-open (leave and join at the same second do not overlap)', () => {
    const sessions: SessionSpan[] = [
      { userId: 1, joinAt: base, leaveAt: base + 600 },
      { userId: 2, joinAt: base + 600, leaveAt: base + 1200 },
    ];
    expect([...aggregateHours(sessions, base, base + H)][0]?.maxOnline).toBe(1);
  });

  it('clips sessions to the requested range and skips empty hours', () => {
    const sessions: SessionSpan[] = [
      { userId: 1, joinAt: base - 5 * H, leaveAt: base + 1800 },
      { userId: 2, joinAt: base + 3 * H, leaveAt: base + 3 * H + 60 },
    ];
    expect([...aggregateHours(sessions, base, base + 4 * H)]).toEqual([
      { hour: base, onlineS: 1800, maxOnline: 1, uniqueUsers: 1 },
      { hour: base + 3 * H, onlineS: 60, maxOnline: 1, uniqueUsers: 1 },
    ]);
  });

  it('yields finished hours before consuming later sessions (streaming)', () => {
    const consumed: number[] = [];
    function* feed(): Generator<SessionSpan> {
      for (let i = 0; i < 3; i++) {
        consumed.push(i);
        yield { userId: i, joinAt: base + i * 2 * H, leaveAt: base + i * 2 * H + 60 };
      }
    }
    const iterator = aggregateHours(feed(), base, base + 10 * H);
    expect(iterator.next().value).toMatchObject({ hour: base });
    expect(consumed).toEqual([0, 1]);
  });

  it('rejects unsorted input', () => {
    const sessions: SessionSpan[] = [
      { userId: 1, joinAt: base + 100, leaveAt: base + 200 },
      { userId: 2, joinAt: base, leaveAt: base + 50 },
    ];
    expect(() => [...aggregateHours(sessions, base, base + H)]).toThrow(/sorted/);
  });
});
