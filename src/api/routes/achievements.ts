import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { FactsReader } from '../../achievements/facts.js';
import { enabledAchievements, globalFacts, runAchievementJob } from '../../achievements/job.js';
import {
  loadAchievementSettings,
  loadAchievementState,
  saveAchievementSettings,
} from '../../achievements/settings.js';
import {
  achievementHolders,
  achievementSummary,
  personAchievements,
  recentAchievements,
} from '../../db/queries/achievements.js';
import { HIDDEN_USERS } from '../../db/queries/stats.js';
import { getPersonOfUser, personUserIds } from '../../db/repositories/index.js';
import {
  ACHIEVEMENT_GROUPS,
  ACHIEVEMENT_IDS,
  ACHIEVEMENTS,
  achievementById,
  achievementProgress,
} from '../../domain/achievements.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const definition = z.object({
  id: z.string(),
  group: z.enum(ACHIEVEMENT_GROUPS),
  unit: z.enum(['seconds', 'days', 'years', 'count']),
  tiers: z.array(z.number()),
  secret: z.boolean(),
  liveOnly: z.boolean(),
});

const latest = z
  .object({
    userId: z.number().int(),
    nickname: z.string().nullable(),
    tier: z.number().int(),
    earnedAt: z.number().int(),
  })
  .nullable();

const stateSchema = z
  .object({
    lastRun: z.number().int(),
    full: z.boolean(),
    checked: z.number().int(),
    awarded: z.number().int(),
    seconds: z.number(),
  })
  .nullable();

export const achievementListResponse = z.object({
  /** Persons with playtime at all – the base of the rarity. */
  persons: z.number().int(),
  achievements: z.array(
    definition.extend({
      /** Secret achievements nobody has yet are shown as "???". */
      revealed: z.boolean(),
      /** Persons per tier (index 0 = tier 1). */
      holders: z.array(z.number().int()),
      latest,
    }),
  ),
  recent: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string().nullable(),
      achievementId: z.string(),
      tier: z.number().int(),
      earnedAt: z.number().int(),
    }),
  ),
  state: stateSchema,
});

export const achievementHoldersResponse = z.object({
  achievementId: z.string(),
  total: z.number().int(),
  holders: z.array(
    z.object({
      userId: z.number().int(),
      nickname: z.string().nullable(),
      tier: z.number().int(),
      earnedAt: z.number().int(),
    }),
  ),
});

export const playerAchievementsResponse = z.object({
  achievements: z.array(
    definition.extend({
      earned: z.array(
        z.object({
          tier: z.number().int(),
          earnedAt: z.number().int(),
          backfilled: z.boolean(),
        }),
      ),
      /** Value now, in the unit of the achievement. */
      value: z.number(),
      /** Threshold of the next tier; null when every tier is reached. */
      nextThreshold: z.number().nullable(),
    }),
  ),
});

const settingsBody = z.object({
  disabled: z.array(z.enum(ACHIEVEMENT_IDS as [string, ...string[]])).max(200),
});

export const achievementSettingsResponse = z.object({
  disabled: z.array(z.string()),
  catalog: z.array(definition),
  state: stateSchema,
});

const describe = (a: (typeof ACHIEVEMENTS)[number]) => ({
  id: a.id,
  group: a.group,
  unit: a.unit,
  tiers: [...a.tiers],
  secret: a.secret,
  liveOnly: a.liveOnly,
});

const publicState = (state: ReturnType<typeof loadAchievementState>) =>
  state
    ? {
        lastRun: state.lastRun,
        full: state.full,
        checked: state.checked,
        awarded: state.awarded,
        seconds: state.seconds,
      }
    : null;

/**
 * Achievements (T13.4): the overview with rarity, the holders of one achievement, a player's
 * badges and progress (all roles), and the switches per achievement (admins only).
 */
export function achievementRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;
    const enabled = () => enabledAchievements(loadAchievementSettings(db).disabled);

    app.get('/achievements', { schema: { response: { 200: achievementListResponse } } }, () => {
      const list = enabled();
      const summary = achievementSummary(sqlite);
      const byId = new Map(summary.achievements.map((a) => [a.achievementId, a]));
      return {
        persons: summary.persons,
        achievements: list.map((a) => {
          const found = byId.get(a.id);
          const holders = a.tiers.map((_, i) => found?.holders[i] ?? 0);
          return {
            ...describe(a),
            revealed: !a.secret || holders.some((n) => n > 0),
            holders,
            latest: found?.latest ?? null,
          };
        }),
        recent: recentAchievements(
          sqlite,
          list.map((a) => a.id),
          10,
        ),
        state: publicState(loadAchievementState(db)),
      };
    });

    app.get(
      '/achievements/:id',
      {
        schema: {
          params: z.object({ id: z.string().max(64) }),
          querystring: z.object({
            page: z.coerce.number().int().min(1).default(1),
            pageSize: z.coerce.number().int().min(1).max(100).default(50),
          }),
          response: { 200: achievementHoldersResponse },
        },
      },
      (request) => {
        const { id } = request.params;
        if (!enabled().some((a) => a.id === id)) {
          throw new ApiError(404, 'ACHIEVEMENT_NOT_FOUND', 'Achievement not found');
        }
        const { page, pageSize } = request.query;
        return {
          achievementId: id,
          ...achievementHolders(sqlite, id, { limit: pageSize, offset: (page - 1) * pageSize }),
        };
      },
    );

    app.get(
      '/users/:id/achievements',
      {
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          response: { 200: playerAchievementsResponse },
        },
      },
      (request) => {
        const { id } = request.params;
        const visible = sqlite
          .prepare(`SELECT 1 FROM users WHERE id = ? AND id NOT IN (${HIDDEN_USERS})`)
          .pluck()
          .get(id);
        if (visible === undefined) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        const userIds = personUserIds(sqlite, id);
        const primary = getPersonOfUser(sqlite, id)?.primaryUserId ?? id;
        const list = enabled();
        const earned = personAchievements(sqlite, userIds);
        const { globals } = globalFacts(sqlite, db, context.now());
        const facts = new FactsReader(sqlite, globals).read(primary, userIds);
        const progress = facts ? achievementProgress(facts, list) : [];
        return {
          achievements: list.map((a) => {
            const p = progress.find((x) => x.achievementId === a.id);
            return {
              ...describe(a),
              earned: earned
                .filter((e) => e.achievementId === a.id)
                .map(({ tier, earnedAt, backfilled }) => ({ tier, earnedAt, backfilled })),
              value: p?.value ?? 0,
              nextThreshold: p ? p.nextThreshold : (a.tiers[0] ?? null),
            };
          }),
        };
      },
    );

    const settingsResponse = () => ({
      disabled: loadAchievementSettings(db).disabled,
      catalog: ACHIEVEMENTS.map(describe),
      state: publicState(loadAchievementState(db)),
    });

    app.get(
      '/settings/achievements',
      { config: { auth: 'admin' }, schema: { response: { 200: achievementSettingsResponse } } },
      () => settingsResponse(),
    );

    app.put(
      '/settings/achievements',
      {
        config: { auth: 'admin' },
        schema: { body: settingsBody, response: { 200: achievementSettingsResponse } },
      },
      (request) => {
        const disabled = [...new Set(request.body.disabled)].filter((id) => achievementById(id));
        disabled.sort();
        request.audit({
          action: 'settings.achievements',
          targetType: 'settings',
          targetId: 'achievements',
          details: { disabled },
        });
        saveAchievementSettings(db, { disabled }, context.now());
        return settingsResponse();
      },
    );

    // Right after switching achievements on, so the page does not wait for the next run.
    app.post(
      '/settings/achievements/run',
      { config: { auth: 'admin' }, schema: { response: { 200: achievementSettingsResponse } } },
      (request) => {
        request.audit({
          action: 'achievements.run',
          targetType: 'settings',
          targetId: 'achievements',
        });
        runAchievementJob(context.database, context.now());
        return settingsResponse();
      },
    );

    return Promise.resolve();
  };
}
