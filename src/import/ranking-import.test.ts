import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../db/client.js';
import { getSetting, upsertUser } from '../db/repositories/index.js';
import { createTestDatabase } from '../db/testing.js';
import { LEGACY_CUTOFF_KEY, rankingTimes } from '../ranks/planner.js';
import {
  importRanking,
  legacyGroupFor,
  LegacyImportError,
  readLegacyRanking,
} from './ranking-import.js';
import { z } from 'zod';

const dir = mkdtempSync(join(tmpdir(), 'ts3a-ranking-'));
const CUTOFF = 1_700_000_000;
const H = 3600;

const UID_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const UID_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBB=';
const UID_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCC=';

const LADDER = [
  { time_required: 15, server_group: 135 },
  { time_required: 360, server_group: 59 },
  { time_required: 1440, server_group: 75 },
];

let database: AppDatabase;
let counter = 0;

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

/** Builds the part of the SinusBot database this module reads. */
function sinusbot(options: {
  current?: Record<string, number>;
  previous?: Record<string, number>;
  ladder?: { time_required: number; server_group: number }[] | undefined;
  extra?: (sqlite: Database.Database) => void;
}): string {
  counter++;
  const path = join(dir, `bot${String(counter)}.sqlite`);
  const sqlite = new Database(path);
  sqlite.exec(
    `CREATE TABLE scriptdata (uuid STRING NOT NULL, keyname STRING NOT NULL, data BLOB NOT NULL,
       meta STRING, PRIMARY KEY (uuid, keyname));
     CREATE TABLE instances (uuid STRING PRIMARY KEY, config TEXT NOT NULL)`,
  );
  const insert = sqlite.prepare(`INSERT INTO scriptdata (uuid, keyname, data) VALUES (?, ?, ?)`);
  for (const [uid, seconds] of Object.entries(options.current ?? {})) {
    insert.run('Tunakills_Rankingsystem', `timetrak${uid}`, String(seconds));
    insert.run('Tunakills_Rankingsystem', `startTime${uid}`, String(CUTOFF));
  }
  for (const [uid, seconds] of Object.entries(options.previous ?? {})) {
    insert.run('Tunakills Rankingsystem', `timetrak${uid}`, String(seconds));
  }
  if (options.ladder) {
    sqlite.prepare(`INSERT INTO instances (uuid, config) VALUES (?, ?)`).run(
      'inst',
      JSON.stringify({
        scriptSettings: {
          Tunakills_Rankingsystem: { settings: { server_group_to_set: options.ladder } },
        },
      }),
    );
  }
  options.extra?.(sqlite);
  sqlite.close();
  return path;
}

describe('legacyGroupFor', () => {
  const ladder = LADDER.map((s) => ({ minutes: s.time_required, groupId: s.server_group }));

  it('picks the highest step whose time is exceeded', () => {
    expect(legacyGroupFor(0, ladder)).toBe(null);
    expect(legacyGroupFor(15 * 60, ladder)).toBe(null); // the old script compared with "<"
    expect(legacyGroupFor(15 * 60 + 1, ladder)).toBe(135);
    expect(legacyGroupFor(10 * H, ladder)).toBe(59);
    expect(legacyGroupFor(100 * H, ladder)).toBe(75);
  });

  it('gives no group without a ladder', () => {
    expect(legacyGroupFor(100 * H, [])).toBe(null);
  });
});

describe('readLegacyRanking', () => {
  it('reads times, ladder and the old data set', () => {
    const path = sinusbot({
      current: { [UID_A]: 10 * H, [UID_B]: 60 },
      previous: { [UID_B]: 5 * H, [UID_C]: 2 * H },
      ladder: LADDER,
    });
    const data = readLegacyRanking(path);
    expect(data.ladder).toEqual([
      { minutes: 15, groupId: 135 },
      { minutes: 360, groupId: 59 },
      { minutes: 1440, groupId: 75 },
    ]);
    expect(data.entries).toEqual([
      { uid: UID_A, seconds: 10 * H, current: 10 * H, previous: 0, groupId: 59 },
      { uid: UID_B, seconds: 5 * H, current: 60, previous: 5 * H, groupId: 135 },
      { uid: UID_C, seconds: 2 * H, current: 0, previous: 2 * H, groupId: 135 },
    ]);
    expect(data.onlyPrevious).toBe(1);
    expect(data.previousLarger).toBe(1);
  });

  it('ignores keys that are not a UID and unusable values', () => {
    const path = sinusbot({
      current: { [UID_A]: 3600 },
      extra: (sqlite) => {
        const insert = sqlite.prepare(
          `INSERT INTO scriptdata (uuid, keyname, data) VALUES (?, ?, ?)`,
        );
        insert.run('Tunakills_Rankingsystem', 'timetrak', '42');
        insert.run('Tunakills_Rankingsystem', 'timetrakserveradmin', '42');
        insert.run('Tunakills_Rankingsystem', 'allUserListed', '[]');
        insert.run('Tunakills_Rankingsystem', `timetrak${UID_B}`, 'keine Zahl');
        insert.run('Tunakills_Rankingsystem', `timetrak${UID_C}`, '-5');
      },
    });
    expect(readLegacyRanking(path).entries.map((e) => e.uid)).toEqual([UID_A]);
  });

  it('works without a ladder in the configuration', () => {
    const data = readLegacyRanking(sinusbot({ current: { [UID_A]: 3600 } }));
    expect(data.ladder).toEqual([]);
    expect(data.entries[0]?.groupId).toBe(null);
  });

  it('explains a file that is not a SinusBot database', () => {
    const path = join(dir, 'leer.sqlite');
    new Database(path).close();
    expect(() => readLegacyRanking(path)).toThrow(LegacyImportError);
    expect(() => readLegacyRanking(join(dir, 'weg.sqlite'))).toThrow(LegacyImportError);
  });
});

describe('importRanking', () => {
  const data = () =>
    readLegacyRanking(sinusbot({ current: { [UID_A]: 10 * H, [UID_B]: 2 * H }, ladder: LADDER }));
  const options = { cutoff: CUTOFF, dryRun: false };

  it('sets the time on a known player and creates the unknown one', () => {
    const existing = upsertUser(database.db, { uid: UID_A, seenAt: CUTOFF - 86_400 });
    const report = importRanking(database, data(), options);

    expect(report).toMatchObject({ entries: 2, known: 1, created: 1, secondsTotal: 12 * H });
    expect(
      database.sqlite
        .prepare(`SELECT legacy_seconds AS s, legacy_rank AS r FROM users WHERE id = ?`)
        .get(existing),
    ).toEqual({ s: 10 * H, r: 59 });
    expect(
      database.sqlite
        .prepare(`SELECT legacy_seconds AS s, legacy_rank AS r FROM users WHERE uid = ?`)
        .get(UID_B),
    ).toEqual({ s: 2 * H, r: 135 });
  });

  it('stores the cutoff the rank engine reads', () => {
    importRanking(database, data(), options);
    expect(getSetting(database.db, LEGACY_CUTOFF_KEY, z.number().int())).toBe(CUTOFF);
  });

  it('sets the value instead of adding it, so a second run changes nothing', () => {
    importRanking(database, data(), options);
    const second = importRanking(database, data(), options);
    expect(second).toMatchObject({ known: 2, created: 0, unchanged: 2 });
    expect(
      database.sqlite.prepare(`SELECT legacy_seconds FROM users WHERE uid = ?`).pluck().get(UID_A),
    ).toBe(10 * H);
  });

  it('writes nothing in a dry run', () => {
    const report = importRanking(database, data(), { ...options, dryRun: true });
    expect(report).toMatchObject({ known: 0, created: 2 });
    expect(database.sqlite.prepare(`SELECT count(*) FROM users`).pluck().get()).toBe(0);
    expect(getSetting(database.db, LEGACY_CUTOFF_KEY, z.number().int())).toBe(undefined);
  });

  it('skips players below the minimum time', () => {
    const report = importRanking(database, data(), { ...options, minSeconds: 5 * H });
    expect(report).toMatchObject({ skipped: 1, created: 1, secondsTotal: 10 * H });
  });

  it('feeds the ranking time of the engine (T6.2)', () => {
    importRanking(database, data(), options);
    const userId = database.sqlite
      .prepare(`SELECT id FROM users WHERE uid = ?`)
      .pluck()
      .get(UID_A) as number;
    expect(rankingTimes(database.sqlite, 'online', { cutoffDay: 20260101 }).get(userId)).toBe(
      10 * H,
    );
  });
});
