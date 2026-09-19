import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getRankOverride,
  getUserById,
  listRanks,
  personUserIds,
  setRankOverride,
} from '../../db/repositories/index.js';
import { hasRole } from '../auth/service.js';
import { planOptions, planRanks } from '../../ranks/planner.js';
import { loadRankSettings } from '../../ranks/settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const MAX_BONUS_H = 100_000;

const rankRef = z.object({ id: z.number().int(), name: z.string() });

export const playerRankResponse = z.object({
  /** False when no ranks are configured. */
  enabled: z.boolean(),
  dryRun: z.boolean(),
  /** Ranking time of the person including bonus. */
  rankingS: z.number().int(),
  target: rankRef.nullable(),
  next: rankRef.extend({ remainingS: z.number().int() }).nullable(),
  /** The rank job has not reached this player yet (offline since the decision). */
  pending: z.boolean(),
  skipped: z.enum(['excluded', 'excluded_group']).nullable(),
  frozen: z.boolean(),
  /** Only for admins. */
  override: z
    .object({
      frozenRankId: z.number().int().nullable(),
      bonusS: z.number().int(),
      excluded: z.boolean(),
      note: z.string().nullable(),
      updatedAt: z.number().int(),
      updatedBy: z.string(),
    })
    .nullable(),
  ranks: z.array(rankRef),
});

const overrideBody = z.object({
  frozenRankId: z.number().int().positive().nullable(),
  bonusHours: z.number().min(-MAX_BONUS_H).max(MAX_BONUS_H),
  excluded: z.boolean(),
  note: z.string().trim().max(500).nullable(),
});

/**
 * Rank of a player (T6.5): what the rank engine decides for the player's person, and the manual
 * overrides (admins only). Overrides are stored for the viewed account and apply to the person.
 */
export function playerRankRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;
    const params = z.object({ id: z.coerce.number().int().positive() });

    const view = (userId: number, isAdmin: boolean) => {
      const settings = loadRankSettings(db);
      const ladder = listRanks(sqlite);
      const ranks = ladder.map((r) => ({ id: r.id, name: r.name }));
      const { entries } = planRanks(sqlite, settings, planOptions(db), [userId]);
      const entry = entries[0];
      const decision = entry?.decision;
      const effectiveS = decision?.kind === 'rank' ? decision.effectiveS : (entry?.rankingS ?? 0);
      const targetId = decision?.kind === 'rank' ? decision.rankId : null;
      const next = ladder.find((r) => r.requiredS > effectiveS);
      const ids = personUserIds(sqlite, userId);
      const pending =
        (sqlite
          .prepare(
            'SELECT count(*) FROM rank_state WHERE pending = 1 AND user_id IN (SELECT value FROM json_each(?))',
          )
          .pluck()
          .get(JSON.stringify(ids)) as number) > 0;
      const override = isAdmin ? (getRankOverride(sqlite, userId) ?? null) : null;
      return {
        enabled: ladder.length > 0,
        dryRun: settings.dryRun,
        rankingS: effectiveS,
        target: ranks.find((r) => r.id === targetId) ?? null,
        next:
          next && decision?.kind === 'rank' && !decision.frozen
            ? { id: next.id, name: next.name, remainingS: next.requiredS - effectiveS }
            : null,
        pending,
        skipped: decision?.kind === 'skip' ? decision.reason : null,
        frozen: decision?.kind === 'rank' && decision.frozen,
        override: override
          ? {
              frozenRankId: override.frozenRankId,
              bonusS: override.bonusS,
              excluded: override.excluded,
              note: override.note,
              updatedAt: override.updatedAt,
              updatedBy: override.updatedBy,
            }
          : null,
        ranks,
      };
    };

    app.get(
      '/users/:id/rank',
      { schema: { params, response: { 200: playerRankResponse } } },
      (request) => {
        if (!getUserById(db, request.params.id)) {
          throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        }
        return view(request.params.id, request.user ? hasRole(request.user.role, 'admin') : false);
      },
    );

    app.put(
      '/users/:id/rank-override',
      {
        config: { auth: 'admin' },
        schema: { params, body: overrideBody, response: { 200: playerRankResponse } },
      },
      (request) => {
        const { id } = request.params;
        const { frozenRankId, bonusHours, excluded, note } = request.body;
        const bonusS = Math.round(bonusHours * 3600);
        request.audit({
          action: 'rank.override',
          targetType: 'user',
          targetId: id,
          details: { frozenRankId, bonusHours, excluded, note },
        });
        if (!getUserById(db, id)) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        if (frozenRankId !== null && !listRanks(sqlite).some((r) => r.id === frozenRankId)) {
          throw new ApiError(400, 'UNKNOWN_RANK', 'Unknown rank');
        }
        setRankOverride(
          sqlite,
          { userId: id, frozenRankId, bonusS, excluded, note: note || null },
          request.user?.username ?? 'unknown',
          context.now(),
        );
        return view(id, true);
      },
    );
    return Promise.resolve();
  };
}
