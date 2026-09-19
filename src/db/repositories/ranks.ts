import type Database from 'better-sqlite3';

export interface Rank {
  id: number;
  name: string;
  sortOrder: number;
  requiredS: number;
  serverGroupId: number;
}

export interface RankInput {
  name: string;
  requiredS: number;
  serverGroupId: number;
}

export interface RankOverride {
  userId: number;
  frozenRankId: number | null;
  bonusS: number;
  excluded: boolean;
  note: string | null;
  updatedAt: number;
  updatedBy: string;
}

export class RankConfigError extends Error {
  constructor(readonly code: 'DUPLICATE_GROUP' | 'NOT_ASCENDING') {
    super(code);
    this.name = 'RankConfigError';
  }
}

export function listRanks(sqlite: Database.Database): Rank[] {
  return sqlite
    .prepare(
      `SELECT id, name, sort_order AS sortOrder, required_s AS requiredS,
              server_group_id AS serverGroupId
       FROM ranks ORDER BY sort_order`,
    )
    .all() as Rank[];
}

/**
 * Replaces the whole ladder in one go (the UI edits it as a list). Existing ranks are matched by
 * id so history and overrides keep pointing at them; ranks missing from the list are deleted.
 * Required times must strictly increase with the order, and each server group may be used once.
 */
export function replaceRanks(
  sqlite: Database.Database,
  ladder: readonly (RankInput & { id?: number | undefined })[],
  now: number,
): Rank[] {
  const groups = new Set(ladder.map((r) => r.serverGroupId));
  if (groups.size !== ladder.length) throw new RankConfigError('DUPLICATE_GROUP');
  for (let i = 1; i < ladder.length; i++) {
    if ((ladder[i]?.requiredS ?? 0) <= (ladder[i - 1]?.requiredS ?? 0)) {
      throw new RankConfigError('NOT_ASCENDING');
    }
  }
  return sqlite.transaction(() => {
    const keep = ladder.flatMap((r) => (r.id === undefined ? [] : [r.id]));
    sqlite
      .prepare('DELETE FROM ranks WHERE id NOT IN (SELECT value FROM json_each(?))')
      .run(JSON.stringify(keep));
    // Move orders and groups out of the way first: both columns are unique.
    sqlite.prepare('UPDATE ranks SET sort_order = -id, server_group_id = -id').run();
    const update = sqlite.prepare(
      `UPDATE ranks SET name = ?, sort_order = ?, required_s = ?, server_group_id = ?, updated_at = ?
       WHERE id = ?`,
    );
    const insert = sqlite.prepare(
      `INSERT INTO ranks (name, sort_order, required_s, server_group_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    ladder.forEach((rank, index) => {
      const order = index + 1;
      if (rank.id !== undefined) {
        update.run(rank.name, order, rank.requiredS, rank.serverGroupId, now, rank.id);
      } else {
        insert.run(rank.name, order, rank.requiredS, rank.serverGroupId, now, now);
      }
    });
    return listRanks(sqlite);
  })();
}

export function getRankOverride(
  sqlite: Database.Database,
  userId: number,
): RankOverride | undefined {
  const row = sqlite
    .prepare(
      `SELECT user_id AS userId, frozen_rank_id AS frozenRankId, bonus_s AS bonusS,
              excluded, note, updated_at AS updatedAt, updated_by AS updatedBy
       FROM rank_overrides WHERE user_id = ?`,
    )
    .get(userId) as (Omit<RankOverride, 'excluded'> & { excluded: number }) | undefined;
  return row ? { ...row, excluded: row.excluded === 1 } : undefined;
}

/** Sets or (with all defaults) removes the override of a user. */
export function setRankOverride(
  sqlite: Database.Database,
  override: Omit<RankOverride, 'updatedAt' | 'updatedBy'>,
  actor: string,
  now: number,
): void {
  const empty =
    override.frozenRankId === null && override.bonusS === 0 && !override.excluded && !override.note;
  if (empty) {
    sqlite.prepare('DELETE FROM rank_overrides WHERE user_id = ?').run(override.userId);
    return;
  }
  sqlite
    .prepare(
      `INSERT INTO rank_overrides (user_id, frozen_rank_id, bonus_s, excluded, note, updated_at,
         updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id) DO UPDATE SET frozen_rank_id = excluded.frozen_rank_id,
         bonus_s = excluded.bonus_s, excluded = excluded.excluded, note = excluded.note,
         updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .run(
      override.userId,
      override.frozenRankId,
      override.bonusS,
      override.excluded ? 1 : 0,
      override.note,
      now,
      actor,
    );
}
