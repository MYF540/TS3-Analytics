import type Database from 'better-sqlite3';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getSetting,
  listRanks,
  RankConfigError,
  replaceRanks,
  type DbExecutor,
} from '../../db/repositories/index.js';
import { rankDirection } from '../../domain/ranks.js';
import { LAST_RUN_KEY } from '../../ranks/job.js';
import { planOptions, planRanks } from '../../ranks/planner.js';
import {
  loadRankSettings,
  rankSettingsSchema,
  saveRankSettings,
  type RankSettings,
} from '../../ranks/settings.js';
import { loadGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';
import { paged, pageQuery } from '../schemas.js';

const PREVIEW_LIMIT = 500;
/** 100 000 hours: far above any realistic ranking time. */
const MAX_REQUIRED_S = 100_000 * 3600;

const rank = z.object({
  id: z.number().int(),
  name: z.string(),
  sortOrder: z.number().int(),
  requiredS: z.number().int(),
  serverGroupId: z.number().int(),
});

const rankInput = z.object({
  id: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(60),
  requiredS: z.number().int().min(0).max(MAX_REQUIRED_S),
  serverGroupId: z.number().int().positive(),
});

const settingsOutput = z.object({
  countMode: z.enum(['online', 'active']),
  excludedGroupIds: z.array(z.number().int()),
  dryRun: z.boolean(),
  intervalMinutes: z.number().int(),
  promotionMessage: z.object({ enabled: z.boolean(), text: z.string() }),
});

export const rankConfigResponse = z.object({
  ranks: z.array(rank),
  settings: settingsOutput,
  knownGroups: z.array(z.object({ id: z.number().int(), name: z.string() })),
  lastRun: z.number().int().nullable(),
});

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
      /** Names as in the (draft) ladder; new draft ranks only exist during the preview. */
      fromRankName: z.string().nullable(),
      toRankName: z.string().nullable(),
      direction: z.enum(['up', 'down']),
      frozen: z.boolean(),
    }),
  ),
});

export const rankHistoryItem = z.object({
  id: z.number().int(),
  at: z.number().int(),
  userId: z.number().int(),
  nickname: z.string().nullable(),
  fromRankId: z.number().int().nullable(),
  toRankId: z.number().int().nullable(),
  fromRankName: z.string().nullable(),
  toRankName: z.string().nullable(),
  rankingS: z.number().int(),
  dryRun: z.boolean(),
  outcome: z.enum(['applied', 'pending', 'dry_run', 'failed']),
});

export const rankRunResponse = z.object({
  skipped: z.enum(['not_connected', 'no_ranks']).nullable(),
  full: z.boolean(),
  dryRun: z.boolean(),
  checked: z.number().int(),
  changed: z.number().int(),
  commands: z.number().int(),
  pending: z.number().int(),
  failed: z.number().int(),
});

const draftBody = z.object({
  ranks: z.array(rankInput).max(100),
  settings: rankSettingsSchema,
});

/** `previousNames`: names of the stored ladder, for ranks the draft deletes. */
function preview(
  sqlite: Database.Database,
  db: DbExecutor,
  settings: RankSettings,
  previousNames: ReadonlyMap<number, string> = new Map(),
) {
  const nickname = sqlite
    .prepare(
      'SELECT nick FROM nicknames WHERE user_id = ? ORDER BY last_seen DESC, id DESC LIMIT 1',
    )
    .pluck();
  const { ladder, entries } = planRanks(sqlite, settings, planOptions(db));
  // The current rank may have been deleted in the draft: look names up in the stored ladder too.
  const names = new Map(
    (sqlite.prepare('SELECT id, name FROM ranks').all() as { id: number; name: string }[]).map(
      (r) => [r.id, r.name],
    ),
  );
  const nameOf = (id: number | null) => (id === null ? null : (names.get(id) ?? null));
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
      fromRankName: previousNames.get(entry.currentRankId ?? -1) ?? nameOf(entry.currentRankId),
      toRankName: nameOf(decision.rankId),
      direction,
      frozen: decision.frozen,
    });
  }
  changes.sort(
    (a, b) =>
      (a.direction === b.direction ? 0 : a.direction === 'up' ? -1 : 1) || b.rankingS - a.rankingS,
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
}

/** Thrown inside a transaction to roll back a draft after computing its preview. */
class Rollback extends Error {}

function sortedLadder(ranks: z.infer<typeof rankInput>[]) {
  return [...ranks].sort((a, b) => a.requiredS - b.requiredS);
}

function configError(error: unknown): never {
  if (error instanceof RankConfigError) {
    throw new ApiError(
      400,
      error.code,
      error.code === 'DUPLICATE_GROUP'
        ? 'Each server group can only be used by one rank'
        : 'Required times must be different',
    );
  }
  throw error;
}

/**
 * Rank configuration (T6.4) and preview (T6.2), admins only. The ladder is always stored sorted
 * by required time; a draft can be previewed without saving (computed and rolled back).
 */
export function rankRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;

    const config = () => ({
      ranks: listRanks(sqlite),
      settings: loadRankSettings(db),
      knownGroups: loadGroupWatch(db).knownGroups,
      lastRun: getSetting(db, LAST_RUN_KEY, z.number().int()) ?? null,
    });

    app.get(
      '/ranks',
      { config: { auth: 'admin' }, schema: { response: { 200: rankConfigResponse } } },
      () => config(),
    );

    app.put(
      '/ranks',
      {
        config: { auth: 'admin' },
        schema: { body: draftBody, response: { 200: rankConfigResponse } },
      },
      (request) => {
        const before = loadRankSettings(db);
        const ladder = sortedLadder(request.body.ranks);
        request.audit({
          action: 'ranks.update',
          targetType: 'settings',
          targetId: 'ranks',
          details: {
            ranks: ladder.map((r) => ({
              name: r.name,
              hours: r.requiredS / 3600,
              group: r.serverGroupId,
            })),
            dryRun: request.body.settings.dryRun,
            ...(before.dryRun === request.body.settings.dryRun ? {} : { dryRunChanged: true }),
            countMode: request.body.settings.countMode,
          },
        });
        try {
          sqlite.transaction(() => {
            replaceRanks(sqlite, ladder, context.now());
            saveRankSettings(db, request.body.settings, context.now());
          })();
        } catch (error) {
          configError(error);
        }
        return config();
      },
    );

    app.get(
      '/ranks/preview',
      { config: { auth: 'admin' }, schema: { response: { 200: rankPreviewResponse } } },
      () => preview(sqlite, db, loadRankSettings(db)),
    );

    app.post(
      '/ranks/preview',
      {
        config: { auth: 'admin' },
        schema: { body: draftBody, response: { 200: rankPreviewResponse } },
      },
      (request) => {
        let result: ReturnType<typeof preview> | undefined;
        const previousNames = new Map(listRanks(sqlite).map((r) => [r.id, r.name]));
        try {
          sqlite.transaction(() => {
            replaceRanks(sqlite, sortedLadder(request.body.ranks), context.now());
            const settings = rankSettingsSchema.parse(request.body.settings);
            result = preview(sqlite, db, settings, previousNames);
            throw new Rollback();
          })();
        } catch (error) {
          if (!(error instanceof Rollback)) configError(error);
        }
        if (!result) throw new Error('Preview was not computed');
        return result;
      },
    );

    app.post(
      '/ranks/run',
      { config: { auth: 'admin' }, schema: { response: { 200: rankRunResponse } } },
      async (request) => {
        request.audit({ action: 'ranks.run', targetType: 'settings', targetId: 'ranks' });
        const job = context.ranks;
        if (!job) throw new ApiError(503, 'TS3_UNAVAILABLE', 'The rank job is not running');
        const result = await job.run({ full: true });
        return { ...result, skipped: result.skipped ?? null };
      },
    );

    app.get(
      '/ranks/history',
      {
        config: { auth: 'admin' },
        schema: {
          querystring: pageQuery.extend({ userId: z.coerce.number().int().positive().optional() }),
          response: { 200: paged(rankHistoryItem) },
        },
      },
      (request) => {
        const { page, pageSize, userId } = request.query;
        const where = userId === undefined ? '' : 'WHERE h.user_id = ?';
        const params = userId === undefined ? [] : [userId];
        const total = sqlite
          .prepare(`SELECT count(*) FROM rank_history h ${where}`)
          .pluck()
          .get(...params) as number;
        const rows = sqlite
          .prepare(
            `SELECT h.id, h.at, h.user_id AS userId,
                    (SELECT nick FROM nicknames n WHERE n.user_id = h.user_id
                     ORDER BY n.last_seen DESC LIMIT 1) AS nickname,
                    h.from_rank_id AS fromRankId, h.to_rank_id AS toRankId,
                    (SELECT name FROM ranks WHERE id = h.from_rank_id) AS fromRankName,
                    (SELECT name FROM ranks WHERE id = h.to_rank_id) AS toRankName,
                    h.ranking_s AS rankingS, h.dry_run AS dryRun, h.outcome
             FROM rank_history h ${where}
             ORDER BY h.at DESC, h.id DESC LIMIT ? OFFSET ?`,
          )
          .all(...params, pageSize, (page - 1) * pageSize) as (Omit<
          z.infer<typeof rankHistoryItem>,
          'dryRun'
        > & { dryRun: number })[];
        return {
          items: rows.map((r) => ({ ...r, dryRun: r.dryRun === 1 })),
          total,
          page,
          pageSize,
        };
      },
    );
    return Promise.resolve();
  };
}
