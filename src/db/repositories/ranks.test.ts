import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadRankSettings } from '../../ranks/settings.js';
import type { AppDatabase } from '../client.js';
import { createTestDatabase } from '../testing.js';
import {
  getRankOverride,
  listRanks,
  RankConfigError,
  replaceRanks,
  setRankOverride,
} from './ranks.js';
import { upsertUser } from './users.js';

let database: AppDatabase;

beforeEach(() => {
  database = createTestDatabase();
});

afterEach(() => {
  database.close();
});

const H = 3600;

describe('rank ladder', () => {
  it('stores the ladder in order and keeps ids when editing', () => {
    const first = replaceRanks(
      database.sqlite,
      [
        { name: 'Neuling', requiredS: 0, serverGroupId: 10 },
        { name: 'Stammgast', requiredS: 50 * H, serverGroupId: 11 },
        { name: 'Veteran', requiredS: 500 * H, serverGroupId: 12 },
      ],
      100,
    );
    expect(first.map((r) => [r.name, r.sortOrder])).toEqual([
      ['Neuling', 1],
      ['Stammgast', 2],
      ['Veteran', 3],
    ]);
    const [neu, stamm, vet] = first;
    // Swap groups, remove the middle rank, add one on top.
    const second = replaceRanks(
      database.sqlite,
      [
        { id: neu?.id, name: 'Neuling', requiredS: 0, serverGroupId: 12 },
        { id: vet?.id, name: 'Veteran', requiredS: 400 * H, serverGroupId: 10 },
        { name: 'Legende', requiredS: 2000 * H, serverGroupId: 13 },
      ],
      200,
    );
    expect(second.map((r) => [r.id === neu?.id, r.name, r.serverGroupId, r.sortOrder])).toEqual([
      [true, 'Neuling', 12, 1],
      [false, 'Veteran', 10, 2],
      [false, 'Legende', 13, 3],
    ]);
    expect(second[1]?.id).toBe(vet?.id);
    expect(listRanks(database.sqlite).some((r) => r.id === stamm?.id)).toBe(false);
  });

  it('rejects duplicate groups and non-ascending times', () => {
    expect(() =>
      replaceRanks(
        database.sqlite,
        [
          { name: 'A', requiredS: 0, serverGroupId: 10 },
          { name: 'B', requiredS: H, serverGroupId: 10 },
        ],
        1,
      ),
    ).toThrow(RankConfigError);
    expect(() =>
      replaceRanks(
        database.sqlite,
        [
          { name: 'A', requiredS: H, serverGroupId: 10 },
          { name: 'B', requiredS: H, serverGroupId: 11 },
        ],
        1,
      ),
    ).toThrow(RankConfigError);
  });
});

describe('rank overrides', () => {
  it('sets, updates and removes an override', () => {
    const userId = upsertUser(database.db, { uid: 'a=', seenAt: 1 });
    const [rank] = replaceRanks(
      database.sqlite,
      [{ name: 'A', requiredS: 0, serverGroupId: 10 }],
      1,
    );
    setRankOverride(
      database.sqlite,
      { userId, frozenRankId: rank?.id ?? null, bonusS: 3600, excluded: false, note: 'Event' },
      'admin',
      5,
    );
    expect(getRankOverride(database.sqlite, userId)).toEqual({
      userId,
      frozenRankId: rank?.id,
      bonusS: 3600,
      excluded: false,
      note: 'Event',
      updatedAt: 5,
      updatedBy: 'admin',
    });
    setRankOverride(
      database.sqlite,
      { userId, frozenRankId: null, bonusS: 0, excluded: false, note: null },
      'admin',
      6,
    );
    expect(getRankOverride(database.sqlite, userId)).toBeUndefined();
  });
});

describe('rank settings', () => {
  it('defaults to online time and dry-run mode', () => {
    expect(loadRankSettings(database.db)).toMatchObject({
      countMode: 'online',
      dryRun: true,
      excludedGroupIds: [],
      promotionMessage: { enabled: true },
    });
  });
});
