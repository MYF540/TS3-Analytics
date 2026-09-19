import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { hashIp, normalizeIp } from '../domain/ip.js';
import { runRetention } from '../jobs/retention.js';
import { createSilentLogger } from '../logging/logger.js';
import { Ts3Connection } from '../ts3/connection.js';
import { FakeTs3Server } from '../ts3/fake-transport.js';
import type { Ts3Ban } from '../ts3/types.js';
import { applyBanList, BanSync } from './bans.js';

const SECRET = 'test-secret-with-at-least-32-characters!';
const NOW = 1_789_800_000;
const DAY = 86_400;

function ban(id: number, fields: Partial<Ts3Ban> = {}): Ts3Ban {
  return {
    banId: id,
    ip: undefined,
    name: undefined,
    uid: undefined,
    lastNickname: undefined,
    reason: 'Beleidigung',
    invokerName: 'Admin',
    invokerUid: 'admin-uid=',
    createdAt: NOW - DAY,
    durationS: 0,
    enforcements: 0,
    ...fields,
  };
}

interface BanRow {
  id: number;
  uid: string | null;
  user_id: number | null;
  ip_hash: Buffer | null;
  subnet_hash: Buffer | null;
  ip_pattern: number;
  name_pattern: string | null;
  removed_at: number | null;
  first_synced: number;
  last_synced: number;
}

let database: AppDatabase;

function rows(): BanRow[] {
  return database.sqlite.prepare('SELECT * FROM bans ORDER BY id').all() as BanRow[];
}

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

describe('applyBanList', () => {
  it('stores UID, name and IP bans with hashes only and links known users', () => {
    const userId = upsertUser(database.db, { uid: 'bad-uid=', seenAt: NOW - 10 * DAY });
    const result = applyBanList(
      database,
      [
        ban(1, { uid: 'bad-uid=', lastNickname: 'Troll' }),
        ban(2, { ip: '203.0.113.7' }),
        ban(3, { ip: '203\\.0\\.113\\..*' }),
        ban(4, { name: '.*troll.*' }),
        ban(5, { uid: 'unknown-uid=' }),
      ],
      SECRET,
      NOW,
    );
    expect(result).toEqual({
      added: 5,
      removed: 0,
      active: 5,
      addedIds: [1, 2, 3, 4, 5],
      initial: true,
    });

    const [uidBan, ipBan, patternBan, nameBan, unknown] = rows();
    expect(uidBan).toMatchObject({ uid: 'bad-uid=', user_id: userId, ip_hash: null });
    const expected = hashIp(normalizeIp('203.0.113.7') ?? (undefined as never), SECRET);
    expect(ipBan?.ip_hash?.equals(expected.ipHash)).toBe(true);
    expect(ipBan?.subnet_hash?.equals(expected.subnetHash)).toBe(true);
    expect(patternBan).toMatchObject({ ip_pattern: 1, ip_hash: null, subnet_hash: null });
    expect(nameBan).toMatchObject({ name_pattern: '.*troll.*', ip_pattern: 0 });
    expect(unknown).toMatchObject({ uid: 'unknown-uid=', user_id: null });

    // No plain address or pattern text anywhere in the table (AGENTS.md rule 1).
    const dump = JSON.stringify(database.sqlite.prepare('SELECT * FROM bans').all());
    expect(dump).not.toContain('203.0.113');
    expect(dump).not.toContain('203\\\\.0');
  });

  it('marks vanished bans as removed and reactivates bans that come back', () => {
    applyBanList(database, [ban(1), ban(2)], SECRET, NOW);
    expect(applyBanList(database, [ban(2), ban(3)], SECRET, NOW + 600)).toMatchObject({
      added: 1,
      removed: 1,
      active: 2,
      addedIds: [3],
      initial: false,
    });
    expect(rows().map((r) => [r.id, r.removed_at])).toEqual([
      [1, NOW + 600],
      [2, null],
      [3, null],
    ]);
    applyBanList(database, [ban(1), ban(2), ban(3)], SECRET, NOW + 1200);
    expect(rows()[0]).toMatchObject({
      removed_at: null,
      first_synced: NOW,
      last_synced: NOW + 1200,
    });
  });

  it('treats an empty list as all bans lifted', () => {
    applyBanList(database, [ban(1)], SECRET, NOW);
    expect(applyBanList(database, [], SECRET, NOW + 60).removed).toBe(1);
  });
});

describe('ban retention', () => {
  it('clears IP hashes of bans removed longer than the IP retention ago', () => {
    applyBanList(
      database,
      [ban(1, { ip: '198.51.100.1' }), ban(2, { ip: '198.51.100.2' })],
      SECRET,
      NOW - 100 * DAY,
    );
    applyBanList(database, [ban(2, { ip: '198.51.100.2' })], SECRET, NOW - 95 * DAY);
    const result = runRetention(database, { ipRetentionDays: 90, segmentRetentionMonths: 0 }, NOW);
    expect(result.banIpHashes).toBe(1);
    const [removed, active] = rows();
    expect(removed).toMatchObject({ ip_hash: null, subnet_hash: null });
    expect(active?.ip_hash).not.toBeNull();
  });
});

describe('BanSync', () => {
  let server: FakeTs3Server;
  let connection: Ts3Connection;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW * 1000 });
    server = new FakeTs3Server(() => Date.now());
    connection = new Ts3Connection(
      server.createTransport,
      { commandsPerSecond: 5, jitter: 0 },
      { logger: createSilentLogger() },
    );
  });

  afterEach(async () => {
    await connection.stop();
    vi.useRealTimers();
  });

  it('syncs after connecting and then periodically', async () => {
    server.bans = [ban(1, { uid: 'x=' })];
    const sync = new BanSync({
      database,
      connection,
      logger: createSilentLogger(),
      hmacSecret: SECRET,
      intervalS: 600,
      now: () => Math.floor(Date.now() / 1000),
    });
    sync.start();
    connection.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(rows().map((r) => r.id)).toEqual([1]);

    server.bans = [ban(2)];
    await vi.advanceTimersByTimeAsync(600_000);
    expect(rows().map((r) => [r.id, r.removed_at === null])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(server.commandLog.filter((c) => c.command === 'banlist')).toHaveLength(2);
    sync.stop();
  });

  it('does not mark anything as removed when the list cannot be read', async () => {
    applyBanList(database, [ban(1)], SECRET, NOW);
    const sync = new BanSync({
      database,
      connection,
      logger: createSilentLogger(),
      hmacSecret: SECRET,
      intervalS: 600,
    });
    // Not connected: the command fails.
    expect(await sync.sync()).toBeUndefined();
    expect(rows()[0]?.removed_at).toBeNull();
  });
});
