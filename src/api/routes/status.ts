import { readFileSync, statSync } from 'node:fs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { recentLogProblems } from '../../logging/recent.js';
import { readHeartbeat } from '../../watcher/recovery.js';
import type { ApiContext } from '../context.js';

const problem = z.object({ at: z.number().int(), message: z.string() });

export const statusResponse = z.object({
  process: z.object({
    version: z.string(),
    nodeVersion: z.string(),
    startedAt: z.number().int(),
    uptimeS: z.number().int(),
    rssBytes: z.number().int(),
    heapUsedBytes: z.number().int(),
  }),
  ts3: z
    .object({
      state: z.string(),
      since: z.number().int(),
      failedAttempts: z.number().int(),
      lastConnectedAt: z.number().int().nullable(),
      lastError: problem.nullable(),
      queuedCommands: z.number().int(),
    })
    .nullable(),
  watcher: z.object({
    lastHeartbeat: z.number().int().nullable(),
    onlineClients: z.number().int().nullable(),
    openSessions: z.number().int(),
  }),
  database: z.object({
    sizeBytes: z.number().int(),
    walBytes: z.number().int().nullable(),
    freeBytes: z.number().int(),
    users: z.number().int(),
    sessions: z.number().int(),
    segments: z.number().int(),
  }),
  jobs: z.array(
    z.object({
      name: z.string(),
      intervalS: z.number().int(),
      lastRun: z.number().int().nullable(),
      nextRun: z.number().int(),
      lastError: problem.nullable(),
    }),
  ),
  problems: z.array(
    z.object({
      at: z.number().int(),
      level: z.enum(['warn', 'error', 'fatal']),
      message: z.string(),
      detail: z.string().nullable(),
      count: z.number().int(),
    }),
  ),
});

function readVersion(): string {
  try {
    // src/api/routes and dist/api/routes are both three levels below the package root.
    const pkg = JSON.parse(
      readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
    ) as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : 'unbekannt';
  } catch {
    return 'unbekannt';
  }
}

function fileSize(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** `GET /api/status`: operational details of the bot for admins (T4.4). */
export function statusRoutes(context: ApiContext): FastifyPluginAsyncZod {
  const version = readVersion();
  return (app) => {
    const { sqlite, db } = context.database;
    const pragma = (name: string) => Number(sqlite.pragma(name, { simple: true }));
    const count = (table: string) =>
      (sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

    app.get(
      '/status',
      { config: { auth: 'admin' }, schema: { response: { 200: statusResponse } } },
      () => {
        const now = context.now();
        const memory = process.memoryUsage();
        const pageSize = pragma('page_size');
        const connection = context.bot?.connection();
        const inMemory = sqlite.memory;
        return {
          process: {
            version,
            nodeVersion: process.version,
            startedAt: context.startedAt,
            uptimeS: Math.max(0, now - context.startedAt),
            rssBytes: memory.rss,
            heapUsedBytes: memory.heapUsed,
          },
          ts3: connection
            ? {
                ...connection,
                lastConnectedAt: connection.lastConnectedAt ?? null,
                lastError: connection.lastError ?? null,
              }
            : null,
          watcher: {
            lastHeartbeat: readHeartbeat(db) ?? null,
            onlineClients: context.live?.liveClients().length ?? null,
            openSessions: (
              sqlite.prepare('SELECT count(*) AS n FROM sessions WHERE leave_at IS NULL').get() as {
                n: number;
              }
            ).n,
          },
          database: {
            sizeBytes: pragma('page_count') * pageSize,
            walBytes: inMemory ? null : fileSize(`${sqlite.name}-wal`),
            freeBytes: pragma('freelist_count') * pageSize,
            users: count('users'),
            sessions: count('sessions'),
            segments: count('activity_segments'),
          },
          jobs: (context.bot?.jobs() ?? []).map((job) => ({
            ...job,
            lastRun: job.lastRun ?? null,
            lastError: job.lastError ?? null,
          })),
          problems: context.bot?.logDir
            ? recentLogProblems(context.bot.logDir).map((p) => ({ ...p, detail: p.detail ?? null }))
            : [],
        };
      },
    );
    return Promise.resolve();
  };
}
