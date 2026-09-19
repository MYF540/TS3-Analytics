import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { FLAG_STATUSES } from '../../db/schema.js';
import { flagsLastRun } from '../../jobs/flag-detection.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';
import { paged, pageQuery } from '../schemas.js';

const LEVELS = ['high', 'medium', 'info'] as const;
const KINDS = ['ban_ip', 'ban_subnet', 'shared_ip'] as const;

const playerRef = z.object({ id: z.number().int(), nickname: z.string().nullable() });

export const flagItem = z.object({
  id: z.number().int(),
  kind: z.enum(KINDS),
  level: z.enum(LEVELS),
  status: z.enum(FLAG_STATUSES),
  user: playerRef,
  related: playerRef.nullable(),
  ban: z
    .object({ id: z.number().int(), reason: z.string().nullable(), active: z.boolean() })
    .nullable(),
  evidence: z.object({
    sharedIps: z.number().int(),
    sharedSubnets: z.number().int(),
    lastSeen: z.number().int(),
  }),
  firstDetected: z.number().int(),
  lastDetected: z.number().int(),
  /** False when the last detection run no longer found the pair (e.g. ban lifted). */
  current: z.boolean(),
  decidedBy: z.string().nullable(),
  decidedAt: z.number().int().nullable(),
});

export const flagsResponse = paged(flagItem).extend({
  /** Open flags per level, for the tabs. */
  openCounts: z.object({
    high: z.number().int(),
    medium: z.number().int(),
    info: z.number().int(),
  }),
  lastRun: z.number().int().nullable(),
});

const NICK = (column: string) =>
  `(SELECT nick FROM nicknames n WHERE n.user_id = ${column} ORDER BY n.last_seen DESC LIMIT 1)`;

interface Row {
  id: number;
  kind: (typeof KINDS)[number];
  level: (typeof LEVELS)[number];
  status: (typeof FLAG_STATUSES)[number];
  userId: number;
  userNick: string | null;
  relatedId: number | null;
  relatedNick: string | null;
  banId: number | null;
  banReason: string | null;
  banRemovedAt: number | null;
  evidence: string;
  firstDetected: number;
  lastDetected: number;
  decidedBy: string | null;
  decidedAt: number | null;
}

/**
 * Alt/evasion hints (T5.2) for moderators and admins. The list shows who is involved and how
 * many IPs/subnets they share – never the hashes themselves.
 */
export function flagRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;

    app.get(
      '/flags',
      {
        config: { auth: 'moderator' },
        schema: {
          querystring: pageQuery.extend({
            status: z.enum([...FLAG_STATUSES, 'all']).default('open'),
            level: z.enum([...LEVELS, 'all']).default('all'),
            userId: z.coerce.number().int().positive().optional(),
          }),
          response: { 200: flagsResponse },
        },
      },
      (request) => {
        const { status, level, userId, page, pageSize } = request.query;
        const where: string[] = [];
        const params: (string | number)[] = [];
        if (status !== 'all') {
          where.push('f.status = ?');
          params.push(status);
        }
        if (level !== 'all') {
          where.push('f.level = ?');
          params.push(level);
        }
        if (userId !== undefined) {
          where.push('(f.user_id = ? OR f.related_user_id = ?)');
          params.push(userId, userId);
        }
        const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const total = sqlite
          .prepare(`SELECT count(*) FROM flags f ${whereSql}`)
          .pluck()
          .get(...params) as number;
        const rows = sqlite
          .prepare(
            `SELECT f.id, f.kind, f.level, f.status, f.user_id AS userId,
                    ${NICK('f.user_id')} AS userNick,
                    f.related_user_id AS relatedId, ${NICK('f.related_user_id')} AS relatedNick,
                    f.ban_id AS banId, b.reason AS banReason, b.removed_at AS banRemovedAt,
                    f.evidence, f.first_detected AS firstDetected,
                    f.last_detected AS lastDetected, f.decided_by AS decidedBy,
                    f.decided_at AS decidedAt
             FROM flags f LEFT JOIN bans b ON b.id = f.ban_id
             ${whereSql}
             ORDER BY CASE f.level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                      f.last_detected DESC, f.id DESC
             LIMIT ? OFFSET ?`,
          )
          .all(...params, pageSize, (page - 1) * pageSize) as Row[];

        const counts = sqlite
          .prepare(`SELECT level, count(*) AS n FROM flags WHERE status = 'open' GROUP BY level`)
          .all() as { level: (typeof LEVELS)[number]; n: number }[];
        const openCounts = { high: 0, medium: 0, info: 0 };
        for (const c of counts) openCounts[c.level] = c.n;
        const lastRun = flagsLastRun(db) ?? null;

        return {
          items: rows.map((r) => ({
            id: r.id,
            kind: r.kind,
            level: r.level,
            status: r.status,
            user: { id: r.userId, nickname: r.userNick },
            related: r.relatedId === null ? null : { id: r.relatedId, nickname: r.relatedNick },
            ban:
              r.banId === null
                ? null
                : { id: r.banId, reason: r.banReason, active: r.banRemovedAt === null },
            evidence: JSON.parse(r.evidence) as z.infer<typeof flagItem>['evidence'],
            firstDetected: r.firstDetected,
            lastDetected: r.lastDetected,
            current: lastRun === null || r.lastDetected >= lastRun,
            decidedBy: r.decidedBy,
            decidedAt: r.decidedAt,
          })),
          total,
          page,
          pageSize,
          openCounts,
          lastRun,
        };
      },
    );

    app.post(
      '/flags/:id/status',
      {
        config: { auth: 'moderator' },
        schema: {
          params: z.object({ id: z.coerce.number().int().positive() }),
          body: z.object({ status: z.enum(FLAG_STATUSES) }),
          response: { 200: z.object({ id: z.number().int(), status: z.enum(FLAG_STATUSES) }) },
        },
      },
      (request) => {
        const { id } = request.params;
        const { status } = request.body;
        const current = sqlite.prepare('SELECT status FROM flags WHERE id = ?').pluck().get(id) as
          string | undefined;
        request.audit({
          action: 'flag.status',
          targetType: 'flag',
          targetId: id,
          details: { from: current ?? null, to: status },
        });
        if (current === undefined) throw new ApiError(404, 'FLAG_NOT_FOUND', 'Flag not found');
        const reopened = status === 'open';
        sqlite
          .prepare('UPDATE flags SET status = ?, decided_by = ?, decided_at = ? WHERE id = ?')
          .run(
            status,
            reopened ? null : (request.user?.username ?? null),
            reopened ? null : context.now(),
            id,
          );
        return { id, status };
      },
    );
    return Promise.resolve();
  };
}
