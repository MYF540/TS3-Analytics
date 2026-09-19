import { describe, expect, it } from 'vitest';
import { decideRank, mergeOverrides, rankDirection, type RankInput } from './ranks.js';

const H = 3600;
const ladder = [
  { id: 1, requiredS: 0, serverGroupId: 10, sortOrder: 1 },
  { id: 2, requiredS: 50 * H, serverGroupId: 11, sortOrder: 2 },
  { id: 3, requiredS: 500 * H, serverGroupId: 12, sortOrder: 3 },
];
const input = (rankingS: number, extra: Partial<RankInput> = {}): RankInput => ({
  rankingS,
  override: undefined,
  inExcludedGroup: false,
  ...extra,
});

describe('decideRank', () => {
  it('picks the highest reached rank, reaching a threshold exactly counts', () => {
    expect(decideRank(ladder, input(0))).toMatchObject({ rankId: 1 });
    expect(decideRank(ladder, input(50 * H - 1))).toMatchObject({ rankId: 1 });
    expect(decideRank(ladder, input(50 * H))).toMatchObject({ rankId: 2 });
    expect(decideRank(ladder, input(10_000 * H))).toMatchObject({ rankId: 3 });
  });

  it('gives no rank below the lowest threshold', () => {
    const noFree = ladder.slice(1);
    expect(decideRank(noFree, input(H))).toEqual({
      kind: 'rank',
      rankId: null,
      frozen: false,
      effectiveS: H,
    });
    expect(decideRank([], input(1000 * H))).toMatchObject({ rankId: null });
  });

  it('adds bonus time (also negative, never below zero)', () => {
    const bonus = (bonusS: number) => ({ frozenRankId: null, bonusS, excluded: false });
    expect(decideRank(ladder, input(40 * H, { override: bonus(10 * H) }))).toMatchObject({
      rankId: 2,
      effectiveS: 50 * H,
    });
    expect(decideRank(ladder, input(60 * H, { override: bonus(-20 * H) }))).toMatchObject({
      rankId: 1,
    });
    expect(decideRank(ladder, input(H, { override: bonus(-5 * H) }))).toMatchObject({
      effectiveS: 0,
    });
  });

  it('keeps a frozen rank while it exists', () => {
    const frozen = (frozenRankId: number) => ({ frozenRankId, bonusS: 0, excluded: false });
    expect(decideRank(ladder, input(1000 * H, { override: frozen(2) }))).toMatchObject({
      rankId: 2,
      frozen: true,
    });
    // Frozen rank was deleted from the ladder: time decides again.
    expect(decideRank(ladder, input(1000 * H, { override: frozen(99) }))).toMatchObject({
      rankId: 3,
      frozen: false,
    });
  });

  it('skips excluded users and members of excluded groups', () => {
    expect(
      decideRank(
        ladder,
        input(1000 * H, { override: { frozenRankId: 2, bonusS: 0, excluded: true } }),
      ),
    ).toEqual({ kind: 'skip', reason: 'excluded' });
    expect(decideRank(ladder, input(1000 * H, { inExcludedGroup: true }))).toEqual({
      kind: 'skip',
      reason: 'excluded_group',
    });
  });
});

describe('mergeOverrides', () => {
  it('combines the overrides of linked accounts', () => {
    expect(mergeOverrides([], 1)).toBeUndefined();
    expect(
      mergeOverrides(
        [
          { userId: 2, frozenRankId: 3, bonusS: H, excluded: false },
          { userId: 1, frozenRankId: 2, bonusS: 2 * H, excluded: false },
        ],
        1,
      ),
    ).toEqual({ frozenRankId: 2, bonusS: 3 * H, excluded: false });
    expect(
      mergeOverrides(
        [
          { userId: 2, frozenRankId: 3, bonusS: 0, excluded: true },
          { userId: 1, frozenRankId: null, bonusS: 0, excluded: false },
        ],
        1,
      ),
    ).toEqual({ frozenRankId: 3, bonusS: 0, excluded: true });
  });
});

describe('rankDirection', () => {
  it('compares ladder positions', () => {
    expect(rankDirection(ladder, 1, 2)).toBe('up');
    expect(rankDirection(ladder, null, 1)).toBe('up');
    expect(rankDirection(ladder, 3, 2)).toBe('down');
    expect(rankDirection(ladder, 1, null)).toBe('down');
    expect(rankDirection(ladder, 2, 2)).toBe('same');
  });
});
