/**
 * Reads the stored player network (T9.2). The heavy lifting happened in the daily job – here
 * only the strongest connections of one window are fetched and decorated with nicknames.
 */
import type Database from 'better-sqlite3';
import type { NetworkRange } from '../schema.js';

export interface NetworkNode {
  userId: number;
  nickname: string | null;
  /** Time that counted towards the network, seconds. */
  seconds: number;
  /** Number of linked UIDs behind this node (1 = not linked). */
  accounts: number;
}

export interface NetworkEdge {
  a: number;
  b: number;
  seconds: number;
  encounters: number;
  /** Share of A's counted time spent with B, and the other way round. */
  shareA: number;
  shareB: number;
}

export interface NetworkGraph {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
  /** Connections stored for this window, even when only some are returned. */
  edgesTotal: number;
  /** Strongest connection of the window, for the slider's scale. */
  strongestS: number;
}

const NICKNAME = `(SELECT n.nick FROM nicknames n WHERE n.user_id = u.id
  ORDER BY n.last_seen DESC, n.id DESC LIMIT 1)`;

const ACCOUNTS = `max(1, (SELECT count(*) FROM person_members m
  JOIN person_members me ON me.person_id = m.person_id WHERE me.user_id = u.id))`;

/** The `limit` strongest connections of a window, with the players they belong to. */
export function networkGraph(
  sqlite: Database.Database,
  options: { range: NetworkRange; limit: number },
): NetworkGraph {
  const edges = sqlite
    .prepare(
      `SELECT user_a AS a, user_b AS b, seconds, encounters FROM network_edges
       WHERE range = ? ORDER BY seconds DESC, user_a, user_b LIMIT ?`,
    )
    .all(options.range, options.limit) as {
    a: number;
    b: number;
    seconds: number;
    encounters: number;
  }[];

  const totals = sqlite
    .prepare(
      `SELECT count(*) AS total, coalesce(max(seconds), 0) AS strongest FROM network_edges
       WHERE range = ?`,
    )
    .get(options.range) as { total: number; strongest: number };

  const ids = [...new Set(edges.flatMap((edge) => [edge.a, edge.b]))];
  const nodes =
    ids.length === 0
      ? []
      : (sqlite
          .prepare(
            `SELECT u.id AS userId, ${NICKNAME} AS nickname, n.seconds, ${ACCOUNTS} AS accounts
             FROM network_nodes n JOIN users u ON u.id = n.user_id
             WHERE n.range = ? AND n.user_id IN (SELECT value FROM json_each(?))
             ORDER BY n.seconds DESC`,
          )
          .all(options.range, JSON.stringify(ids)) as NetworkNode[]);

  const secondsOf = new Map(nodes.map((node) => [node.userId, node.seconds]));
  const share = (seconds: number, userId: number) => {
    const total = secondsOf.get(userId) ?? 0;
    return total > 0 ? seconds / total : 0;
  };

  return {
    nodes,
    edges: edges.map((edge) => ({
      ...edge,
      shareA: share(edge.seconds, edge.a),
      shareB: share(edge.seconds, edge.b),
    })),
    edgesTotal: totals.total,
    strongestS: totals.strongest,
  };
}
