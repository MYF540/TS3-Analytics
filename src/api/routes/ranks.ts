import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { rankDirection } from '../../domain/ranks.js';
import { planOptions, planRanks } from '../../ranks/planner.js';
import { loadRankSettings } from '../../ranks/settings.js';
import type { ApiContext } from '../context.js';

const PREVIEW_LIMIT = 500;

export const rankPreviewResponse = z.object({
  dryRun: z.boolean(),
  counts: z.object({ up: z.number().int(), down: z.number().int(), skipped: z.number().int() }),
  /** Changes of the next run, promotions first; at most 500. */
  changes: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string().nullable(),
      accounts: z.number().int(),
      rankingS: z.number().int(),
      fromRankId: z.number().int().nullable(),
      toRankId: z.number().int().nullable(),
      direction: z.enum(['up', 'down']),
      frozen: z.boolean(),
    }),
  ),
});

/** Rank preview (T6.2): who would be promoted or demoted by the next rank job run. */
export function rankRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;
    const nickname = sqlite
      .prepare(
        'SELECT nick FROM nicknames WHERE user_id = ? ORDER BY last_seen DESC, id DESC LIMIT 1',
      )
      .pluck();

    app.get(
      '/ranks/preview',
      { config: { auth: 'admin' }, schema: { response: { 200: rankPreviewResponse } } },
      () => {
        const settings = loadRankSettings(db);
        const { ladder, entries } = planRanks(sqlite, settings, planOptions(db));
        let skipped = 0;
        const changes = [];
        for (const entry of entries) {
          const { decision } = entry;
          if (decision.kind === 'skip') {
            skipped++;
            continue;
          }
          const direction = rankDirection(ladder, entry.currentRankId, decision.rankId);
          // Also covers new users below the lowest rank (no rank before, none after).
          if (direction === 'same') continue;
          changes.push({
            userId: entry.primaryUserId,
            nickname: (nickname.get(entry.primaryUserId) as string | undefined) ?? null,
            accounts: entry.userIds.length,
            rankingS: decision.effectiveS,
            fromRankId: entry.currentRankId,
            toRankId: decision.rankId,
            direction,
            frozen: decision.frozen,
          });
        }
        changes.sort(
          (a, b) =>
            (a.direction === b.direction ? 0 : a.direction === 'up' ? -1 : 1) ||
            b.rankingS - a.rankingS,
        );
        return {
          dryRun: settings.dryRun,
          counts: {
            up: changes.filter((c) => c.direction === 'up').length,
            down: changes.filter((c) => c.direction === 'down').length,
            skipped,
          },
          changes: changes.slice(0, PREVIEW_LIMIT),
        };
      },
    );
    return Promise.resolve();
  };
}
