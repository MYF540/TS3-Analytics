import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { upsertIpSeen, upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { hashIp, normalizeIp } from '../domain/ip.js';
import { applyBanList } from '../watcher/bans.js';
import { flagsLastRun, runFlagDetection } from './flag-detection.js';

const SECRET = 'test-secret-with-at-least-32-characters!';
const NOW = 1_789_800_000;

let database: AppDatabase;
const ids: Record<string, number> = {};

function sawIp(user: string, ip: string, at = NOW - 3600) {
  const normalized = normalizeIp(ip);
  if (!normalized) throw new Error(ip);
  const hashes = hashIp(normalized, SECRET);
  upsertIpSeen(database.db, { userId: ids[user] ?? 0, ...hashes, country: null, seenAt: at });
}

function flagRows() {
  return database.sqlite
    .prepare(
      `SELECT kind, level, user_id AS userId, related_user_id AS relatedUserId, status, evidence
       FROM flags ORDER BY kind, user_id`,
    )
    .all() as {
    kind: string;
    level: string;
    userId: number;
    relatedUserId: number | null;
    status: string;
    evidence: string;
  }[];
}

beforeEach(() => {
  database = createTestDatabase();
  for (const name of ['banned', 'alt', 'neighbour', 'sibling']) {
    ids[name] = upsertUser(database.db, { uid: `${name}=`, seenAt: NOW - 86_400 });
  }
  sawIp('banned', '203.0.113.10');
  sawIp('alt', '203.0.113.10');
  sawIp('neighbour', '203.0.113.99');
  sawIp('sibling', '198.51.100.5');
  sawIp('alt', '198.51.100.5');
  applyBanList(
    database,
    [
      {
        banId: 1,
        uid: 'banned=',
        ip: undefined,
        name: undefined,
        lastNickname: undefined,
        reason: undefined,
        invokerName: undefined,
        invokerUid: undefined,
        createdAt: NOW - 7200,
        durationS: 0,
        enforcements: 0,
      },
    ],
    SECRET,
    NOW - 60,
  );
});

afterEach(() => {
  database.close();
});

describe('runFlagDetection', () => {
  it('stores high, medium and info flags with counts as evidence', () => {
    expect(runFlagDetection(database, NOW)).toEqual({ detected: 3, created: 3 });
    expect(flagRows()).toEqual([
      {
        kind: 'ban_ip',
        level: 'high',
        userId: ids.alt,
        relatedUserId: ids.banned,
        status: 'open',
        evidence: JSON.stringify({ sharedIps: 1, sharedSubnets: 1, lastSeen: NOW - 3600 }),
      },
      expect.objectContaining({ kind: 'ban_subnet', level: 'medium', userId: ids.neighbour }),
      expect.objectContaining({ kind: 'shared_ip', level: 'info', status: 'open' }),
    ]);
    expect(flagsLastRun(database.db)).toBe(NOW);
    // Evidence never contains hashes.
    expect(JSON.stringify(flagRows())).not.toMatch(/[0-9A-F]{32}/);
  });

  it('keeps decisions: ignored pairs are not flagged again', () => {
    runFlagDetection(database, NOW);
    database.sqlite
      .prepare(`UPDATE flags SET status = 'ignored', decided_by = 'admin' WHERE kind = 'shared_ip'`)
      .run();
    sawIp('sibling', '192.0.2.44', NOW);
    sawIp('alt', '192.0.2.44', NOW);
    expect(runFlagDetection(database, NOW + 900)).toEqual({ detected: 3, created: 0 });
    const shared = flagRows().find((f) => f.kind === 'shared_ip');
    expect(shared).toMatchObject({ status: 'ignored' });
    expect(JSON.parse(shared?.evidence ?? '{}')).toMatchObject({ sharedIps: 2 });
  });

  it('keeps flags of lifted bans with their old detection time', () => {
    runFlagDetection(database, NOW);
    applyBanList(database, [], SECRET, NOW + 60);
    // Without the ban, alt and banned simply share an IP.
    expect(runFlagDetection(database, NOW + 900)).toEqual({ detected: 2, created: 1 });
    const lastDetected = database.sqlite
      .prepare(`SELECT last_detected FROM flags WHERE kind = 'ban_ip'`)
      .pluck()
      .get();
    expect(lastDetected).toBe(NOW);
  });
});
