import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { berlinDayStart } from '../../domain/time.js';
import { finalizeSegment, finalizeSession } from '../aggregates.js';
import type { AppDatabase } from '../client.js';
import {
  extendSegments,
  linkUsers,
  openSegment,
  openSession,
  upsertChannels,
  upsertUser,
} from '../repositories/index.js';
import { createTestDatabase } from '../testing.js';
import { channelUsage, unusedChannels } from './channels.js';

const H = 3600;
const DAY1 = berlinDayStart(20260914);
const NOW = DAY1 + 10 * 86_400;

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
  upsertChannels(database.db, [
    { id: 1, name: 'Lobby', seenAt: NOW },
    { id: 2, name: 'Zocken', seenAt: NOW },
    { id: 3, name: 'AFK', seenAt: NOW },
    { id: 4, name: 'Alter Channel', seenAt: DAY1 },
  ]);
});

afterEach(() => {
  database.close();
});

function user(uid: string): number {
  return upsertUser(database.db, { uid, seenAt: DAY1 });
}

/** One closed session in `channelId`. */
function visit(userId: number, channelId: number, startAt: number, seconds: number): void {
  const sessionId = openSession(database.db, userId, startAt);
  const seg = openSegment(database.db, {
    userId,
    sessionId,
    channelId,
    state: 'active',
    startAt,
  });
  finalizeSegment(database, seg, startAt + seconds);
  finalizeSession(database, sessionId, startAt + seconds);
}

const usage = (from: number, to: number) =>
  channelUsage(database.sqlite, { from, to, limit: 10, presentSince: NOW - 86_400 });

describe('channelUsage', () => {
  it('sums time per channel and counts players and visits', () => {
    const alice = user('uid-alice');
    const bob = user('uid-bob');
    visit(alice, 1, NOW - 5 * 86_400, 2 * H);
    visit(bob, 1, NOW - 4 * 86_400, H);
    visit(bob, 1, NOW - 3 * 86_400, H);
    visit(alice, 2, NOW - 2 * 86_400, 30 * 60);

    const result = usage(NOW - 30 * 86_400, NOW);
    expect(result.items).toEqual([
      {
        channelId: 1,
        name: 'Lobby',
        seconds: 4 * H,
        users: 2,
        visits: 3,
        lastUsed: NOW - 3 * 86_400 + H,
        present: true,
      },
      {
        channelId: 2,
        name: 'Zocken',
        seconds: 30 * 60,
        users: 1,
        visits: 1,
        lastUsed: NOW - 2 * 86_400 + 30 * 60,
        present: true,
      },
    ]);
    expect(result.total).toBe(2);
    expect(result.totalSeconds).toBe(4 * H + 30 * 60);
  });

  it('counts linked UIDs as one person (T5.3)', () => {
    const alice = user('uid-alice');
    const bob = user('uid-bob');
    linkUsers(database.sqlite, alice, bob, 'test', DAY1);
    visit(alice, 1, NOW - 2 * 86_400, H);
    visit(bob, 1, NOW - 86_400, H);
    expect(usage(NOW - 30 * 86_400, NOW).items[0]).toMatchObject({ users: 1, visits: 2 });
  });

  it('clips a segment that started before the window', () => {
    const alice = user('uid-alice');
    visit(alice, 1, NOW - 3 * H, 3 * H);
    expect(usage(NOW - H, NOW).items).toEqual([
      expect.objectContaining({ channelId: 1, seconds: H }),
    ]);
  });

  it('leaves out segments outside the window', () => {
    const alice = user('uid-alice');
    visit(alice, 1, NOW - 40 * 86_400, H);
    expect(usage(NOW - 7 * 86_400, NOW).items).toEqual([]);
  });

  it('counts an open segment, clipped to the end of the window', () => {
    const alice = user('uid-alice');
    const sessionId = openSession(database.db, alice, NOW - 2 * H);
    const seg = openSegment(database.db, {
      userId: alice,
      sessionId,
      channelId: 2,
      state: 'active',
      startAt: NOW - 2 * H,
    });
    extendSegments(database.db, [{ id: seg, endAt: NOW }]);
    expect(usage(NOW - 7 * 86_400, NOW).items).toEqual([
      expect.objectContaining({ channelId: 2, seconds: 2 * H }),
    ]);
  });

  it('marks a channel that is no longer in the channel list', () => {
    const alice = user('uid-alice');
    visit(alice, 4, NOW - 2 * 86_400, H);
    expect(usage(NOW - 30 * 86_400, NOW).items).toEqual([
      expect.objectContaining({ channelId: 4, name: 'Alter Channel', present: false }),
    ]);
  });

  it('returns the top channels but counts all of them', () => {
    const alice = user('uid-alice');
    for (let id = 10; id < 15; id++) {
      upsertChannels(database.db, [{ id, name: `C${String(id)}`, seenAt: NOW }]);
      visit(alice, id, NOW - 2 * 86_400 - id * H, id * 60);
    }
    const result = channelUsage(database.sqlite, {
      from: NOW - 30 * 86_400,
      to: NOW,
      limit: 2,
      presentSince: NOW - 86_400,
    });
    expect(result.items.map((item) => item.channelId)).toEqual([14, 13]);
    expect(result.total).toBe(5);
    expect(result.totalSeconds).toBe((10 + 11 + 12 + 13 + 14) * 60);
  });
});

describe('unusedChannels', () => {
  const unused = (days: number) =>
    unusedChannels(database.sqlite, {
      since: NOW - days * 86_400,
      now: NOW,
      presentSince: NOW - 86_400,
    });

  it('lists existing channels nobody used in the period', () => {
    const alice = user('uid-alice');
    visit(alice, 1, NOW - 3 * 86_400, H);
    visit(alice, 2, NOW - 20 * 86_400, H);
    expect(unused(7)).toEqual([
      { channelId: 3, name: 'AFK', lastSeen: NOW },
      { channelId: 2, name: 'Zocken', lastSeen: NOW },
    ]);
    expect(unused(30).map((c) => c.channelId)).toEqual([3]);
  });

  it('ignores channels that are gone from the server', () => {
    expect(unused(30).map((c) => c.channelId)).not.toContain(4);
  });

  it('does not report a channel somebody is sitting in right now', () => {
    const alice = user('uid-alice');
    const sessionId = openSession(database.db, alice, NOW - H);
    openSegment(database.db, {
      userId: alice,
      sessionId,
      channelId: 3,
      state: 'active',
      startAt: NOW - H,
    });
    expect(unused(7).map((c) => c.channelId)).not.toContain(3);
  });
});
