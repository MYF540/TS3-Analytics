import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { onlineSeries, overview, weekdayHourHeatmap } from '../../db/queries/stats.js';
import { rangeSeconds, TIME_RANGES, todayBounds } from '../../domain/periods.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const rangeQuery = z.object({ range: z.enum(TIME_RANGES).default('30d') });

/** Earliest hour with data, used for the range "all". */
function firstDataAt(context: ApiContext): number {
  const first = context.database.sqlite
    .prepare('SELECT min(hour) FROM server_hourly')
    .pluck()
    .get() as number | null;
  return first ?? context.now();
}

export const overviewResponse = z.object({
  range: z.enum(TIME_RANGES),
  onlineNow: z.number().int(),
  peakToday: z.number().int(),
  peakInRange: z.number().int(),
  peakAllTime: z.number().int(),
  usersTotal: z.number().int(),
  usersNew: z.number().int(),
});

export const seriesResponse = z.object({
  from: z.number().int(),
  to: z.number().int(),
  /** Bucket size in seconds. */
  resolution: z.number().int(),
  points: z.array(z.object({ t: z.number().int(), avgOnline: z.number(), maxOnline: z.number() })),
});

export const sourcesResponse = z.object({
  /** First and last imported session (T8.6), null when nothing was imported. */
  importedFrom: z.number().int().nullable(),
  importedTo: z.number().int().nullable(),
  /** First session the watcher recorded itself; only from here on there is activity data. */
  liveSince: z.number().int().nullable(),
});

export const heatmapResponse = z.object({
  range: z.enum(TIME_RANGES),
  /** 7 rows (Monday first) × 24 hours, average users online (Berlin time). */
  values: z.array(z.array(z.number())),
});

/** Where the data of a period comes from. Rarely changes, so one lookup per minute is enough. */
function dataSources(context: ApiContext): z.output<typeof sourcesResponse> {
  const { sqlite } = context.database;
  const edge = (source: 'import' | 'live', order: 'ASC' | 'DESC') =>
    (sqlite
      .prepare(`SELECT join_at FROM sessions WHERE source = ? ORDER BY join_at ${order} LIMIT 1`)
      .pluck()
      .get(source) as number | undefined) ?? null;
  return {
    importedFrom: edge('import', 'ASC'),
    importedTo: edge('import', 'DESC'),
    liveSince: edge('live', 'ASC'),
  };
}

export function statsRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite } = context.database;
    let cached: { at: number; value: z.output<typeof sourcesResponse> } | undefined;

    app.get(
      '/stats/overview',
      { schema: { querystring: rangeQuery, response: { 200: overviewResponse } } },
      (request) => {
        const now = context.now();
        const { from, to } = rangeSeconds(request.query.range, now, firstDataAt(context));
        return {
          range: request.query.range,
          ...overview(sqlite, from, to, todayBounds(now).start),
        };
      },
    );

    app.get(
      '/stats/online',
      {
        schema: {
          querystring: rangeQuery.extend({
            from: z.coerce.number().int().optional(),
            to: z.coerce.number().int().optional(),
          }),
          response: { 200: seriesResponse },
        },
      },
      (request) => {
        const now = context.now();
        const defaults = rangeSeconds(request.query.range, now, firstDataAt(context));
        const from = request.query.from ?? defaults.from;
        const to = request.query.to ?? defaults.to;
        if (to <= from) throw new ApiError(400, 'INVALID_RANGE', '"to" must be after "from"');
        return { from, to, ...onlineSeries(sqlite, from, to) };
      },
    );

    app.get('/stats/sources', { schema: { response: { 200: sourcesResponse } } }, () => {
      const now = context.now();
      if (!cached || now - cached.at > 60) cached = { at: now, value: dataSources(context) };
      return cached.value;
    });

    app.get(
      '/stats/heatmap',
      { schema: { querystring: rangeQuery, response: { 200: heatmapResponse } } },
      (request) => {
        const { from, to } = rangeSeconds(request.query.range, context.now(), firstDataAt(context));
        return { range: request.query.range, values: weekdayHourHeatmap(sqlite, from, to) };
      },
    );
    return Promise.resolve();
  };
}
