/**
 * Rank engine (T6.2): pure functions that turn ranking time and overrides into a target rank.
 * The rank job (T6.3) applies the result; this module never touches the server.
 */

export interface LadderRank {
  id: number;
  /** Ranking time needed, seconds. */
  requiredS: number;
  serverGroupId: number;
}

export interface OverrideInput {
  frozenRankId: number | null;
  bonusS: number;
  excluded: boolean;
}

export interface RankInput {
  /** Ranking time: legacy time + live time after the cutoff (AGENTS.md rule 12). */
  rankingS: number;
  override: OverrideInput | undefined;
  /** Member of an excluded server group (admins, bots …). */
  inExcludedGroup: boolean;
}

export type RankDecision =
  /** Do not manage this user at all: no rank group is set or removed. */
  | { kind: 'skip'; reason: 'excluded' | 'excluded_group' }
  /** `rankId` null: below the lowest rank, so no rank group. */
  | { kind: 'rank'; rankId: number | null; frozen: boolean; effectiveS: number };

/**
 * The highest rank whose required time is reached (ties: exactly reaching counts). A frozen rank
 * wins as long as it still exists in the ladder; otherwise the time decides.
 */
export function decideRank(ladder: readonly LadderRank[], input: RankInput): RankDecision {
  const { override } = input;
  if (override?.excluded) return { kind: 'skip', reason: 'excluded' };
  if (input.inExcludedGroup) return { kind: 'skip', reason: 'excluded_group' };
  const effectiveS = Math.max(0, input.rankingS + (override?.bonusS ?? 0));
  if (override?.frozenRankId != null && ladder.some((r) => r.id === override.frozenRankId)) {
    return { kind: 'rank', rankId: override.frozenRankId, frozen: true, effectiveS };
  }
  let rankId: number | null = null;
  let best = -1;
  for (const rank of ladder) {
    if (rank.requiredS <= effectiveS && rank.requiredS > best) {
      best = rank.requiredS;
      rankId = rank.id;
    }
  }
  return { kind: 'rank', rankId, frozen: false, effectiveS };
}

/**
 * Overrides of all linked accounts of a person, combined: excluded if any account is excluded,
 * bonus times add up, and a frozen rank of the primary account wins over the others'.
 */
export function mergeOverrides(
  overrides: readonly (OverrideInput & { userId: number })[],
  primaryUserId: number,
): OverrideInput | undefined {
  if (overrides.length === 0) return undefined;
  const frozen =
    overrides.find((o) => o.userId === primaryUserId && o.frozenRankId !== null)?.frozenRankId ??
    overrides.find((o) => o.frozenRankId !== null)?.frozenRankId ??
    null;
  return {
    excluded: overrides.some((o) => o.excluded),
    bonusS: overrides.reduce((sum, o) => sum + o.bonusS, 0),
    frozenRankId: frozen,
  };
}

/** Where a change moves the user in the ladder, for the preview. */
export function rankDirection(
  ladder: readonly (LadderRank & { sortOrder: number })[],
  current: number | null,
  target: number | null,
): 'up' | 'down' | 'same' {
  if (current === target) return 'same';
  const order = (id: number | null) =>
    id === null ? 0 : (ladder.find((r) => r.id === id)?.sortOrder ?? 0);
  return order(target) > order(current) ? 'up' : 'down';
}
