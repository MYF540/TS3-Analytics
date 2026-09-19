import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { loadGroupWatch, saveGroupWatch } from '../../watcher/group-settings.js';
import type { ApiContext } from '../context.js';
import { paged, pageQuery } from '../schemas.js';

export const groupSettingsResponse = z.object({
  protectedGroupIds: z.array(z.number().int()),
  knownGroups: z.array(z.object({ id: z.number().int(), name: z.string() })),
});

export const groupChange = z.object({
  id: z.number().int(),
  at: z.number().int(),
  action: z.enum(['added', 'removed']),
  userId: z.number().int().nullable(),
  nickname: z.string().nullable(),
  groupId: z.number().int(),
  groupName: z.string(),
  invokerName: z.string(),
  protected: z.boolean(),
});

/** Protected server groups and the history of group changes (T5.7). */
export function groupRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db, sqlite } = context.database;
    const response = () => {
      const { protectedGroupIds, knownGroups } = loadGroupWatch(db);
      return { protectedGroupIds, knownGroups };
    };

    app.get(
      '/settings/groups',
      { config: { auth: 'admin' }, schema: { response: { 200: groupSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/settings/groups',
      {
        config: { auth: 'admin' },
        schema: {
          body: z.object({ protectedGroupIds: z.array(z.number().int().positive()).max(100) }),
          response: { 200: groupSettingsResponse },
        },
      },
      (request) => {
        const ids = [...new Set(request.body.protectedGroupIds)].sort((a, b) => a - b);
        request.audit({
          action: 'settings.groups',
          targetType: 'settings',
          targetId: 'groups',
          details: { protectedGroupIds: ids },
        });
        saveGroupWatch(db, { ...loadGroupWatch(db), protectedGroupIds: ids }, context.now());
        return response();
      },
    );

    app.get(
      '/group-changes',
      {
        config: { auth: 'moderator' },
        schema: {
          querystring: pageQuery.extend({
            protectedOnly: z.stringbool().default(false),
            userId: z.coerce.number().int().positive().optional(),
          }),
          response: { 200: paged(groupChange) },
        },
      },
      (request) => {
        const { page, pageSize, protectedOnly, userId } = request.query;
        const where: string[] = [];
        const params: number[] = [];
        if (protectedOnly) where.push('protected = 1');
        if (userId !== undefined) {
          where.push('user_id = ?');
          params.push(userId);
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const total = sqlite
          .prepare(`SELECT count(*) FROM group_changes ${whereSql}`)
          .pluck()
          .get(...params) as number;
        const rows = sqlite
          .prepare(
            `SELECT id, at, action, user_id AS userId, nickname, group_id AS groupId,
                    group_name AS groupName, invoker_name AS invokerName, protected
             FROM group_changes ${whereSql}
             ORDER BY log_pos DESC, id DESC LIMIT ? OFFSET ?`,
          )
          .all(...params, pageSize, (page - 1) * pageSize) as (Omit<
          z.infer<typeof groupChange>,
          'protected'
        > & { protected: number })[];
        return {
          items: rows.map((r) => ({ ...r, protected: r.protected === 1 })),
          total,
          page,
          pageSize,
        };
      },
    );
    return Promise.resolve();
  };
}
