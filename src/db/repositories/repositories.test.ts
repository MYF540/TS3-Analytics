import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppDatabase } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  closeSegment,
  closeSession,
  extendSegments,
  getCurrentNickname,
  getNicknames,
  getOpenSegments,
  getOpenSessionForUser,
  getOpenSessions,
  getSetting,
  getUserById,
  getUserByUid,
  InvalidSettingError,
  openSegment,
  openSession,
  recordNickname,
  recordServerMinute,
  setSetting,
  upsertChannels,
  upsertIpSeen,
  upsertUser,
  type DbExecutor,
} from './index.js';

const T0 = 1_780_000_000; // arbitrary fixed point in time
const UID = 'aBcDeFgHiJkLmNoPqRsTuVwXyZ0=';

let database: AppDatabase;
let db: DbExecutor;

beforeEach(() => {
  database = createTestDatabase();
  db = database.db;
});

afterEach(() => {
  database.close();
});

describe('users', () => {
  it('inserts a new user and returns its id', () => {
    const id = upsertUser(db, { uid: UID, seenAt: T0, dbid: 42, platform: 'Windows' });
    expect(getUserById(db, id)).toMatchObject({
      uid: UID,
      dbid: 42,
      firstSeen: T0,
      lastSeen: T0,
      platform: 'Windows',
      version: null,
      country: null,
    });
  });

  it('updates an existing user by UID and keeps the same id', () => {
    const id = upsertUser(db, { uid: UID, seenAt: T0, dbid: 42, platform: 'Windows' });
    const again = upsertUser(db, { uid: UID, seenAt: T0 + 100, version: '3.6.2', country: 'DE' });
    expect(again).toBe(id);
    expect(getUserByUid(db, UID)).toMatchObject({
      dbid: 42, // unknown values keep the stored value
      platform: 'Windows',
      version: '3.6.2',
      country: 'DE',
      firstSeen: T0,
      lastSeen: T0 + 100,
    });
  });

  it('never moves first_seen forward or last_seen backward', () => {
    upsertUser(db, { uid: UID, seenAt: T0 });
    upsertUser(db, { uid: UID, seenAt: T0 - 50 }); // e.g. late import
    upsertUser(db, { uid: UID, seenAt: T0 + 10 });
    upsertUser(db, { uid: UID, seenAt: T0 + 5 });
    expect(getUserByUid(db, UID)).toMatchObject({ firstSeen: T0 - 50, lastSeen: T0 + 10 });
  });

  it('distinguishes users by UID, not by nickname', () => {
    const a = upsertUser(db, { uid: 'uid-a', seenAt: T0 });
    const b = upsertUser(db, { uid: 'uid-b', seenAt: T0 });
    recordNickname(db, a, 'SameNick', T0);
    recordNickname(db, b, 'SameNick', T0);
    expect(a).not.toBe(b);
    expect(getNicknames(db, a)).toHaveLength(1);
    expect(getNicknames(db, b)).toHaveLength(1);
  });
});

describe('nicknames', () => {
  it('tracks nick changes as history, most recent first', () => {
    const id = upsertUser(db, { uid: UID, seenAt: T0 });
    recordNickname(db, id, 'Alpha', T0);
    recordNickname(db, id, 'Alpha', T0 + 60);
    recordNickname(db, id, 'Beta', T0 + 120);

    expect(getCurrentNickname(db, id)).toBe('Beta');
    expect(getNicknames(db, id)).toMatchObject([
      { nick: 'Beta', firstSeen: T0 + 120, lastSeen: T0 + 120 },
      { nick: 'Alpha', firstSeen: T0, lastSeen: T0 + 60 },
    ]);

    recordNickname(db, id, 'Alpha', T0 + 180); // switching back reuses the row
    expect(getCurrentNickname(db, id)).toBe('Alpha');
    expect(getNicknames(db, id)).toHaveLength(2);
  });

  it('returns undefined for a user without nicknames', () => {
    const id = upsertUser(db, { uid: UID, seenAt: T0 });
    expect(getCurrentNickname(db, id)).toBeUndefined();
  });
});

describe('sessions', () => {
  it('opens and closes a session with its duration', () => {
    const userId = upsertUser(db, { uid: UID, seenAt: T0 });
    const sessionId = openSession(db, userId, T0);
    expect(getOpenSessionForUser(db, userId)).toMatchObject({ id: sessionId, leaveAt: null });

    const closed = closeSession(db, sessionId, T0 + 3600);
    expect(closed).toEqual({
      id: sessionId,
      userId,
      joinAt: T0,
      leaveAt: T0 + 3600,
      duration: 3600,
      source: 'live',
    });
    expect(getOpenSessions(db)).toEqual([]);
  });

  it('does not close a session twice', () => {
    const userId = upsertUser(db, { uid: UID, seenAt: T0 });
    const sessionId = openSession(db, userId, T0);
    closeSession(db, sessionId, T0 + 10);
    expect(closeSession(db, sessionId, T0 + 20)).toBeUndefined();
    expect(closeSession(db, 9999, T0)).toBeUndefined();
  });

  it('clamps a leave time before the join time', () => {
    const userId = upsertUser(db, { uid: UID, seenAt: T0 });
    const sessionId = openSession(db, userId, T0);
    expect(closeSession(db, sessionId, T0 - 5)).toMatchObject({ leaveAt: T0, duration: 0 });
  });

  it('lists all open sessions', () => {
    const a = upsertUser(db, { uid: 'uid-a', seenAt: T0 });
    const b = upsertUser(db, { uid: 'uid-b', seenAt: T0 });
    const sa = openSession(db, a, T0 + 10);
    const sb = openSession(db, b, T0);
    openSession(db, b, T0 - 100, 'import');
    closeSession(db, sb, T0 + 1);
    expect(getOpenSessions(db).map((s) => s.userId)).toEqual([b, a]);
    expect(getOpenSessionForUser(db, a)?.id).toBe(sa);
  });
});

describe('activity segments', () => {
  function setup() {
    const userId = upsertUser(db, { uid: UID, seenAt: T0 });
    const sessionId = openSession(db, userId, T0);
    upsertChannels(db, [{ id: 7, name: 'Lobby', seenAt: T0 }]);
    return { userId, sessionId };
  }

  it('opens, extends and closes a segment', () => {
    const { userId, sessionId } = setup();
    const id = openSegment(db, { userId, sessionId, channelId: 7, state: 'active', startAt: T0 });
    expect(getOpenSegments(db)).toMatchObject([{ id, startAt: T0, endAt: T0, isOpen: true }]);

    extendSegments(db, [{ id, endAt: T0 + 60 }]);
    extendSegments(db, [{ id, endAt: T0 + 120 }]);
    expect(getOpenSegments(db)[0]?.endAt).toBe(T0 + 120);

    const closed = closeSegment(db, id, T0 + 150);
    expect(closed).toMatchObject({
      id,
      userId,
      sessionId,
      channelId: 7,
      state: 'active',
      startAt: T0,
      endAt: T0 + 150,
      isOpen: false,
    });
    expect(getOpenSegments(db)).toEqual([]);
  });

  it('never shortens a segment', () => {
    const { userId, sessionId } = setup();
    const id = openSegment(db, { userId, sessionId, channelId: 7, state: 'idle', startAt: T0 });
    extendSegments(db, [{ id, endAt: T0 + 120 }]);
    extendSegments(db, [{ id, endAt: T0 + 60 }]);
    expect(getOpenSegments(db)[0]?.endAt).toBe(T0 + 120);
    expect(closeSegment(db, id, T0 + 90)?.endAt).toBe(T0 + 120);
  });

  it('ignores extend and close on closed segments', () => {
    const { userId, sessionId } = setup();
    const id = openSegment(db, { userId, sessionId, channelId: 7, state: 'afk', startAt: T0 });
    closeSegment(db, id, T0 + 30);
    extendSegments(db, [{ id, endAt: T0 + 300 }]);
    expect(closeSegment(db, id, T0 + 400)).toBeUndefined();
  });

  it('extends many segments in one transaction', () => {
    const { userId, sessionId } = setup();
    const ids = [0, 1, 2].map((i) =>
      openSegment(db, { userId, sessionId, channelId: 7, state: 'active', startAt: T0 + i }),
    );
    database.db.transaction((tx) => {
      extendSegments(
        tx,
        ids.map((id) => ({ id, endAt: T0 + 600 })),
      );
    });
    expect(getOpenSegments(db).map((s) => s.endAt)).toEqual([T0 + 600, T0 + 600, T0 + 600]);
  });

  it('rolls back all writes when a transaction fails', () => {
    const { userId, sessionId } = setup();
    expect(() => {
      database.db.transaction((tx) => {
        openSegment(tx, { userId, sessionId, channelId: 7, state: 'active', startAt: T0 });
        throw new Error('boom');
      });
    }).toThrow('boom');
    expect(getOpenSegments(db)).toEqual([]);
  });

  it('keeps segments when their channel is deleted', () => {
    const { userId, sessionId } = setup();
    openSegment(db, { userId, sessionId, channelId: 7, state: 'active', startAt: T0 });
    database.sqlite.prepare('DELETE FROM channels WHERE id = 7').run();
    expect(getOpenSegments(db)[0]?.channelId).toBeNull();
  });
});

describe('channels', () => {
  it('inserts and renames channels', () => {
    upsertChannels(db, [
      { id: 1, name: 'Lobby', seenAt: T0 },
      { id: 2, name: 'AFK', seenAt: T0 },
    ]);
    upsertChannels(db, [{ id: 1, name: 'Eingang', seenAt: T0 + 60 }]);
    upsertChannels(db, []);
    expect(database.sqlite.prepare('SELECT id, name, last_seen FROM channels').all()).toEqual([
      { id: 1, name: 'Eingang', last_seen: T0 + 60 },
      { id: 2, name: 'AFK', last_seen: T0 },
    ]);
  });
});

describe('settings', () => {
  const idleSchema = z.object({ thresholdS: z.number().int() });

  it('stores and reads JSON values', () => {
    expect(getSetting(db, 'idle', idleSchema)).toBeUndefined();
    setSetting(db, 'idle', { thresholdS: 300 }, T0);
    expect(getSetting(db, 'idle', idleSchema)).toEqual({ thresholdS: 300 });
    setSetting(db, 'idle', { thresholdS: 600 }, T0 + 1);
    expect(getSetting(db, 'idle', idleSchema)).toEqual({ thresholdS: 600 });
  });

  it('rejects stored values that do not match the schema', () => {
    setSetting(db, 'idle', { thresholdS: 'soon' }, T0);
    expect(() => getSetting(db, 'idle', idleSchema)).toThrow(InvalidSettingError);
  });
});

describe('server minutely', () => {
  it('stores one value per minute', () => {
    const minute = T0 - (T0 % 60);
    recordServerMinute(db, minute + 5, 10);
    recordServerMinute(db, minute + 30, 12); // same minute → overwrite
    recordServerMinute(db, minute + 65, 11);
    expect(database.sqlite.prepare('SELECT ts, online FROM server_minutely').all()).toEqual([
      { ts: minute, online: 12 },
      { ts: minute + 60, online: 11 },
    ]);
  });
});

describe('ip_seen', () => {
  const hmac = (value: string) => createHmac('sha256', 'test-secret').update(value).digest();

  it('counts repeated sightings of the same hash', () => {
    const userId = upsertUser(db, { uid: UID, seenAt: T0 });
    const sighting = {
      userId,
      ipHash: hmac('ip-1'),
      subnetHash: hmac('subnet-1'),
      country: 'DE',
      seenAt: T0,
    };
    upsertIpSeen(db, sighting);
    upsertIpSeen(db, { ...sighting, country: null, seenAt: T0 + 100 });
    upsertIpSeen(db, { ...sighting, ipHash: hmac('ip-2'), seenAt: T0 + 200 });

    const rows = database.sqlite
      .prepare('SELECT ip_hash, country, first_seen, last_seen, seen_count FROM ip_seen')
      .all() as { ip_hash: Buffer; country: string; seen_count: number; last_seen: number }[];
    expect(rows).toHaveLength(2);
    const first = rows.find((r) => r.ip_hash.equals(hmac('ip-1')));
    expect(first).toMatchObject({ country: 'DE', seen_count: 2, last_seen: T0 + 100 });
  });
});
