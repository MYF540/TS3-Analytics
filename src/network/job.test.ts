import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { finalizeSegment, finalizeSession } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import {
  linkUsers,
  openSegment,
  openSession,
  upsertChannels,
  upsertUser,
} from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import type { ActivityState } from '../db/schema.js';
import { loadActivitySettings, saveActivitySettings } from '../watcher/settings.js';
import { runNetworkJob } from './job.js';
import { loadNetworkState, saveNetworkSettings } from './settings.js';

const H = 3600;
const NOW = 1_789_800_000;

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
  upsertChannels(database.db, [
    { id: 1, name: 'Talk', seenAt: NOW },
    { id: 2, name: 'Lobby', seenAt: NOW },
    { id: 9, name: 'AFK', seenAt: NOW },
  ]);
});

afterEach(() => {
  database.close();
});

function player(uid: string): number {
  return upsertUser(database.db, { uid, seenAt: NOW - 40 * 86_400 });
}

/** One closed session with a single segment. */
function visit(
  userId: number,
  channelId: number,
  startAt: number,
  seconds: number,
  state: ActivityState = 'active',
): void {
  const sessionId = openSession(database.db, userId, startAt);
  const seg = openSegment(database.db, { userId, sessionId, channelId, state, startAt });
  finalizeSegment(database, seg, startAt + seconds);
  finalizeSession(database, sessionId, startAt + seconds);
}

const edges = (range = '30d') =>
  database.sqlite
    .prepare(
      `SELECT user_a AS a, user_b AS b, seconds, encounters FROM network_edges
       WHERE range = ? ORDER BY seconds DESC, a, b`,
    )
    .all(range) as { a: number; b: number; seconds: number; encounters: number }[];

describe('runNetworkJob', () => {
  it('stores an edge for two players in the same channel', () => {
    const a = player('uid-a');
    const b = player('uid-b');
    visit(a, 1, NOW - 5 * 86_400, 3 * H);
    visit(b, 1, NOW - 5 * 86_400 + H, 3 * H);

    const { state } = runNetworkJob(database, NOW);
    expect(edges()).toEqual([{ a, b, seconds: 2 * H, encounters: 1 }]);
    expect(state.ranges['30d']).toMatchObject({ nodes: 2, edges: 1 });
    expect(
      database.sqlite
        .prepare(`SELECT seconds FROM network_nodes WHERE range = '30d' AND user_id = ?`)
        .pluck()
        .get(a),
    ).toBe(3 * H);
  });

  it('fills every window', () => {
    const a = player('uid-a');
    const b = player('uid-b');
    visit(a, 1, NOW - 200 * 86_400, 3 * H); // only inside 1y and all
    visit(b, 1, NOW - 200 * 86_400, 3 * H);

    runNetworkJob(database, NOW);
    expect(edges('30d')).toEqual([]);
    expect(edges('90d')).toEqual([]);
    expect(edges('1y')).toHaveLength(1);
    expect(edges('all')).toHaveLength(1);
  });

  it('leaves out AFK time and excluded channels', () => {
    const a = player('uid-a');
    const b = player('uid-b');
    const at = NOW - 3 * 86_400;
    visit(a, 9, at, 3 * H, 'afk'); // AFK channel
    visit(b, 9, at, 3 * H, 'afk');
    visit(a, 2, at + 10 * H, 3 * H); // lobby, excluded by the settings
    visit(b, 2, at + 10 * H, 3 * H);
    saveActivitySettings(
      database.db,
      { ...loadActivitySettings(database.db), afkChannelIds: [9] },
      NOW,
    );
    saveNetworkSettings(database.db, { excludedChannelIds: [2] }, NOW);

    runNetworkJob(database, NOW);
    expect(edges()).toEqual([]);
  });

  it('counts idle time, because sitting in a channel is company', () => {
    const a = player('uid-a');
    const b = player('uid-b');
    visit(a, 1, NOW - 86_400, 2 * H, 'idle');
    visit(b, 1, NOW - 86_400, 2 * H, 'idle');
    runNetworkJob(database, NOW);
    expect(edges()).toHaveLength(1);
  });

  it('treats linked accounts as one person and never links them with themselves', () => {
    const a = player('uid-a');
    const alt = player('uid-a-alt');
    const b = player('uid-b');
    linkUsers(database.sqlite, a, alt, 'test', NOW);
    visit(alt, 1, NOW - 86_400, 2 * H);
    visit(b, 1, NOW - 86_400, 2 * H);

    runNetworkJob(database, NOW);
    // The edge belongs to the primary account, not to the second one.
    expect(edges()).toEqual([
      { a: Math.min(a, b), b: Math.max(a, b), seconds: 2 * H, encounters: 1 },
    ]);
  });

  it('keeps pairs below the minimum out of the database', () => {
    const a = player('uid-a');
    const b = player('uid-b');
    visit(a, 1, NOW - 86_400, 10 * 60);
    visit(b, 1, NOW - 86_400, 10 * 60);
    saveNetworkSettings(database.db, { minPairS: H }, NOW);

    const { state } = runNetworkJob(database, NOW);
    expect(edges()).toEqual([]);
    expect(state.ranges['30d']?.droppedPairs).toBe(1);
  });

  it('limits the network to the most active players', () => {
    // Twelve players in one channel, the later ones stay longer.
    const ids = Array.from({ length: 12 }, (_, i) => player(`uid-${String(i)}`));
    ids.forEach((id, i) => {
      visit(id, 1, NOW - 86_400, (i + 1) * H);
    });
    saveNetworkSettings(database.db, { candidates: 10 }, NOW);

    runNetworkJob(database, NOW);
    const involved = new Set(edges().flatMap((e) => [e.a, e.b]));
    expect(involved.size).toBe(10);
    expect(involved.has(ids[0] as number)).toBe(false);
    expect(involved.has(ids[1] as number)).toBe(false);
    expect(involved.has(ids[11] as number)).toBe(true);
  });

  it('replaces the previous result instead of adding to it', () => {
    const a = player('uid-a');
    const b = player('uid-b');
    visit(a, 1, NOW - 86_400, 2 * H);
    visit(b, 1, NOW - 86_400, 2 * H);
    runNetworkJob(database, NOW);
    runNetworkJob(database, NOW);
    expect(edges()).toEqual([{ a, b, seconds: 2 * H, encounters: 1 }]);
  });

  it('records when it ran and how long it took', () => {
    runNetworkJob(database, NOW);
    const state = loadNetworkState(database.db);
    expect(state?.computedAt).toBe(NOW);
    expect(state?.seconds).toBeGreaterThanOrEqual(0);
    expect(Object.keys(state?.ranges ?? {})).toEqual(['30d', '90d', '1y', 'all']);
  });

  it('works on an empty database', () => {
    expect(() => runNetworkJob(database, NOW)).not.toThrow();
    expect(edges()).toEqual([]);
  });
});
