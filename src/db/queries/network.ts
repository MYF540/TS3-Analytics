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
  /** Group of players who mostly meet each other, 0 = largest; null until the job ran (T12.2). */
  community: number | null;
  /** ISO country code of the primary account, as last reported. */
  country: string | null;
  /** Latest sighting of any of the person's accounts. */
  lastSeen: number;
  /** Current rank of the ladder (`ranks.id`); null = none or not decided yet. */
  rankId: number | null;
  /** Server groups of all the person's accounts, as of their last sighting. */
  serverGroups: number[];
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

export interface NetworkQuery {
  range: NetworkRange;
  limit: number;
  /** Only connections with at least this much time together, seconds. */
  minS?: number;
  /** Only this player's surroundings: their partners (depth 1) and the partners' partners (2). */
  focus?: { userId: number; depth: 1 | 2 } | undefined;
}

const NICKNAME = `(SELECT n.nick FROM nicknames n WHERE n.user_id = u.id
  ORDER BY n.last_seen DESC, n.id DESC LIMIT 1)`;

/** Every account of the node's person, the node itself included. */
const ACCOUNTS_OF = `(SELECT u.id UNION SELECT m.user_id FROM person_members m
  JOIN person_members me ON me.person_id = m.person_id WHERE me.user_id = u.id)`;

const ACCOUNTS = `max(1, (SELECT count(*) FROM person_members m
  JOIN person_members me ON me.person_id = m.person_id WHERE me.user_id = u.id))`;

/** Edges of the window, optionally limited to strong ones and to one player's surroundings. */
function selectEdges(sqlite: Database.Database, query: NetworkQuery) {
  const minS = query.minS ?? 0;
  if (!query.focus) {
    return sqlite
      .prepare(
        `SELECT user_a AS a, user_b AS b, seconds, encounters FROM network_edges
         WHERE range = ? AND seconds >= ? ORDER BY seconds DESC, user_a, user_b LIMIT ?`,
      )
      .all(query.range, minS, query.limit) as Omit<NetworkEdge, 'shareA' | 'shareB'>[];
  }
  const { userId, depth } = query.focus;
  // The ball around the player: themselves, their partners and – at depth 2 – the partners'
  // partners. Only connections inside the ball are drawn. A window holds at most a few ten
  // thousand edges, so walking them in memory is faster than a recursive query (which took
  // ~250 ms for depth 2 on the synthetic database).
  const all = sqlite
    .prepare(
      `SELECT user_a, user_b, seconds, encounters FROM network_edges
       WHERE range = ? AND seconds >= ?`,
    )
    .raw()
    .all(query.range, minS) as [number, number, number, number][];
  const ball = new Set([userId]);
  for (let step = 0; step < depth; step++) {
    const frontier = [...ball];
    const inner = new Set(frontier);
    for (const [a, b] of all) {
      if (inner.has(a)) ball.add(b);
      else if (inner.has(b)) ball.add(a);
    }
  }
  return all
    .filter(([a, b]) => ball.has(a) && ball.has(b))
    .sort((x, y) => y[2] - x[2] || x[0] - y[0] || x[1] - y[1])
    .slice(0, query.limit)
    .map(([a, b, seconds, encounters]) => ({ a, b, seconds, encounters }));
}

/** Union of the stored group lists (`users.server_groups`, JSON) of a person's accounts. */
function parseGroups(json: string | null): number[] {
  const groups = new Set<number>();
  for (const entry of JSON.parse(json ?? '[]') as (string | null)[]) {
    if (entry === null) continue;
    for (const id of JSON.parse(entry) as unknown[]) if (typeof id === 'number') groups.add(id);
  }
  return [...groups].sort((a, b) => a - b);
}

/** The `limit` strongest connections of a window, with the players they belong to. */
export function networkGraph(sqlite: Database.Database, query: NetworkQuery): NetworkGraph {
  const edges = selectEdges(sqlite, query);

  const totals = sqlite
    .prepare(
      `SELECT count(*) AS total, coalesce(max(seconds), 0) AS strongest FROM network_edges
       WHERE range = ?`,
    )
    .get(query.range) as { total: number; strongest: number };

  const ids = [...new Set(edges.flatMap((edge) => [edge.a, edge.b]))];
  const rows =
    ids.length === 0
      ? []
      : (sqlite
          .prepare(
            `SELECT u.id AS userId, ${NICKNAME} AS nickname, n.seconds, ${ACCOUNTS} AS accounts,
               n.community, u.country,
               (SELECT max(x.last_seen) FROM users x WHERE x.id IN ${ACCOUNTS_OF}) AS lastSeen,
               (SELECT json_group_array(x.server_groups) FROM users x WHERE x.id IN ${ACCOUNTS_OF})
                 AS groups,
               (SELECT r.rank_id FROM rank_state r WHERE r.user_id = u.id) AS rankId
             FROM network_nodes n JOIN users u ON u.id = n.user_id
             WHERE n.range = ? AND n.user_id IN (SELECT value FROM json_each(?))
             ORDER BY n.seconds DESC`,
          )
          .all(query.range, JSON.stringify(ids)) as (Omit<NetworkNode, 'serverGroups'> & {
          groups: string | null;
        })[]);
  const nodes: NetworkNode[] = rows.map(({ groups, ...node }) => ({
    ...node,
    serverGroups: parseGroups(groups),
  }));

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
