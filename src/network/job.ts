/**
 * Computes the player network once a day (T9.1).
 *
 * The network does not have to be live, so it is not computed on request: a year would take
 * hundreds of milliseconds and "all" more than a second (docs/performance.md). Instead every
 * window is computed once and stored; the page only reads finished rows.
 *
 * Both queries here deliberately avoid joining `persons`: the mapping of linked UIDs happens in
 * memory afterwards. A `COALESCE(primary_user_id, user_id)` in the WHERE clause cannot use an
 * index and turned a 30-day run into a full scan of every segment ever recorded.
 */
import type Database from 'better-sqlite3';
import type { AppDatabase } from '../db/client.js';
import { HIDDEN_USERS } from '../db/queries/stats.js';
import { NETWORK_RANGES, type NetworkRange } from '../db/schema.js';
import { buildCoPresence, type CoPresenceSegment } from '../domain/co-presence.js';
import { loadActivitySettings } from '../watcher/settings.js';
import {
  loadNetworkSettings,
  networkWindow,
  saveNetworkState,
  type NetworkSettings,
  type NetworkState,
} from './settings.js';

/**
 * Longest segment we expect. It lets the queries start the index scan at `from - MAX_SEGMENT_S`
 * instead of at the beginning of time, and still catches segments that began before the window.
 */
const MAX_SEGMENT_S = 86_400;

interface Window {
  from: number;
  to: number;
}

/** Channels that never count: the ones chosen for the network plus the AFK channels. */
function excludedChannels(database: AppDatabase, settings: NetworkSettings): number[] {
  const activity = loadActivitySettings(database.db);
  return [...new Set([...settings.excludedChannelIds, ...activity.afkChannelIds])];
}

/** Maps every linked account to its primary account; everybody else maps to themselves. */
function personMap(sqlite: Database.Database): Map<number, number> {
  const rows = sqlite
    .prepare(
      `SELECT m.user_id, p.primary_user_id FROM person_members m
       JOIN persons p ON p.id = m.person_id`,
    )
    .raw()
    .all() as [number, number][];
  return new Map(rows);
}

const WINDOW_FILTER = `is_open = 0 AND state <> 'afk'
   AND start_at >= ? - ${String(MAX_SEGMENT_S)} AND start_at < ? AND end_at > ?`;

/**
 * The most active people of the window. Restricting the network to them keeps the number of
 * pairs bounded – with every player it would grow with the square of the player count.
 * Aggregating per account first and mapping to persons afterwards keeps the query index-friendly.
 */
function candidates(
  sqlite: Database.Database,
  window: Window,
  excluded: number[],
  persons: Map<number, number>,
  limit: number,
): Set<number> {
  const rows = sqlite
    .prepare(
      `SELECT user_id, sum(min(end_at, ?) - max(start_at, ?)) AS seconds
       FROM activity_segments
       WHERE ${WINDOW_FILTER}
         AND (channel_id IS NULL OR channel_id NOT IN (SELECT value FROM json_each(?)))
         AND user_id NOT IN (${HIDDEN_USERS})
       GROUP BY user_id
       HAVING seconds > 0`,
    )
    .raw()
    .all(window.to, window.from, window.from, window.to, window.from, JSON.stringify(excluded)) as [
    number,
    number,
  ][];

  const perSubject = new Map<number, number>();
  for (const [userId, seconds] of rows) {
    const subject = persons.get(userId) ?? userId;
    perSubject.set(subject, (perSubject.get(subject) ?? 0) + seconds);
  }
  return new Set(
    [...perSubject.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, limit)
      .map(([subject]) => subject),
  );
}

/** Segments of the candidates, ordered by start – exactly what the sweep line expects. */
function* segmentsOf(
  sqlite: Database.Database,
  window: Window,
  excluded: number[],
  persons: Map<number, number>,
  subjects: ReadonlySet<number>,
): Generator<CoPresenceSegment> {
  const rows = sqlite
    .prepare(
      `SELECT user_id, channel_id, start_at, end_at FROM activity_segments
       WHERE ${WINDOW_FILTER} AND channel_id IS NOT NULL
         AND channel_id NOT IN (SELECT value FROM json_each(?))
       ORDER BY start_at`,
    )
    .raw()
    .iterate(window.from, window.to, window.from, JSON.stringify(excluded)) as IterableIterator<
    [number, number, number, number]
  >;
  for (const [userId, channelId, startAt, endAt] of rows) {
    const subject = persons.get(userId) ?? userId;
    if (!subjects.has(subject)) continue;
    yield { subject, channelId, startAt, endAt };
  }
}

export interface ComputedNetwork {
  window: Window;
  nodes: Map<number, number>;
  edges: { a: number; b: number; seconds: number; encounters: number }[];
  droppedPairs: number;
}

/** Computes one window without touching the database. Used by the job and by `pnpm bench`. */
export function computeNetwork(
  database: AppDatabase,
  range: NetworkRange,
  now: number,
  firstData: number,
  settings: NetworkSettings,
  excluded: number[],
): ComputedNetwork {
  const { sqlite } = database;
  const window = networkWindow(range, now, firstData);
  const persons = personMap(sqlite);
  const subjects = candidates(sqlite, window, excluded, persons, settings.candidates);
  const result = buildCoPresence(segmentsOf(sqlite, window, excluded, persons, subjects), {
    from: window.from,
    to: window.to,
    minEncounterS: settings.minEncounterS,
    minPairS: settings.minPairS,
  });
  return {
    window,
    nodes: result.nodes,
    edges: result.edges,
    droppedPairs: result.droppedPairs,
  };
}

/** Recomputes one window and replaces its stored rows. */
function computeRange(
  database: AppDatabase,
  range: NetworkRange,
  now: number,
  firstData: number,
  settings: NetworkSettings,
  excluded: number[],
): NetworkState['ranges'][string] {
  const { sqlite } = database;
  const result = computeNetwork(database, range, now, firstData, settings, excluded);

  const insertNode = sqlite.prepare(
    `INSERT INTO network_nodes (range, user_id, seconds) VALUES (?, ?, ?)`,
  );
  const insertEdge = sqlite.prepare(
    `INSERT INTO network_edges (range, user_a, user_b, seconds, encounters) VALUES (?, ?, ?, ?, ?)`,
  );
  // Nodes without a single edge would be lonely dots in the graph, so they are left out.
  const connected = new Set<number>();
  for (const edge of result.edges) {
    connected.add(edge.a);
    connected.add(edge.b);
  }

  sqlite.transaction(() => {
    sqlite.prepare(`DELETE FROM network_edges WHERE range = ?`).run(range);
    sqlite.prepare(`DELETE FROM network_nodes WHERE range = ?`).run(range);
    for (const subject of connected) {
      insertNode.run(range, subject, result.nodes.get(subject) ?? 0);
    }
    for (const edge of result.edges) {
      insertEdge.run(range, edge.a, edge.b, edge.seconds, edge.encounters);
    }
  })();

  return {
    nodes: connected.size,
    edges: result.edges.length,
    droppedPairs: result.droppedPairs,
    from: result.window.from,
    to: result.window.to,
  };
}

/** Recomputes every window. Runs daily and on demand from the settings page. */
export function runNetworkJob(database: AppDatabase, now: number): NetworkJobResult {
  const started = Date.now();
  const settings = loadNetworkSettings(database.db);
  const excluded = excludedChannels(database, settings);
  const firstData =
    (database.sqlite.prepare(`SELECT min(start_at) FROM activity_segments`).pluck().get() as
      number | null) ?? now;

  const ranges: NetworkState['ranges'] = {};
  for (const range of NETWORK_RANGES) {
    ranges[range] = computeRange(database, range, now, firstData, settings, excluded);
  }

  const state: NetworkState = {
    computedAt: now,
    seconds: (Date.now() - started) / 1000,
    ranges,
  };
  saveNetworkState(database.db, state, now);
  return { state };
}

export interface NetworkJobResult {
  state: NetworkState;
}
