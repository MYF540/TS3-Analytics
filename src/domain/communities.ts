/**
 * Groups of players who mostly meet each other (T12.2): Louvain community detection on the
 * weighted co-presence network. Pure and deterministic – nodes are visited in id order and ties
 * go to the smaller community – so the colours of the network page do not change between two
 * runs over the same data.
 */

export interface WeightedEdge {
  a: number;
  b: number;
  weight: number;
}

/** Adjacency of one level: node index → neighbour index → weight (self loops included). */
type Graph = Map<number, number>[];

/** Moves of less than this are rounding noise and would make the loop run forever. */
const EPSILON = 1e-12;

function buildGraph(size: number, edges: Iterable<[number, number, number]>): Graph {
  const graph: Graph = Array.from({ length: size }, () => new Map<number, number>());
  for (const [a, b, weight] of edges) {
    if (weight <= 0) continue;
    const from = graph[a];
    const to = graph[b];
    if (!from || !to) continue;
    from.set(b, (from.get(b) ?? 0) + weight);
    if (a !== b) to.set(a, (to.get(a) ?? 0) + weight);
  }
  return graph;
}

/** Degree of a node; a self loop counts twice, as in the modularity formula. */
function degree(graph: Graph, node: number): number {
  let sum = 0;
  for (const [other, weight] of graph[node] ?? []) sum += other === node ? 2 * weight : weight;
  return sum;
}

/** One local-moving phase. Returns each node's community (renumbered 0..k-1) and whether any moved. */
function moveNodes(graph: Graph): { community: number[]; moved: boolean } {
  const size = graph.length;
  const degrees = graph.map((_, node) => degree(graph, node));
  const twiceTotal = degrees.reduce((sum, value) => sum + value, 0);
  const community = Array.from({ length: size }, (_, node) => node);
  const totals = [...degrees];
  let moved = false;
  if (twiceTotal === 0) return { community, moved };

  for (let improved = true; improved;) {
    improved = false;
    for (let node = 0; node < size; node++) {
      const own = community[node] ?? node;
      const k = degrees[node] ?? 0;
      // Weights from this node into each neighbouring community.
      const links = new Map<number, number>();
      for (const [other, weight] of graph[node] ?? []) {
        if (other === node) continue;
        const target = community[other] ?? other;
        links.set(target, (links.get(target) ?? 0) + weight);
      }
      totals[own] = (totals[own] ?? 0) - k;
      const gain = (target: number) =>
        (links.get(target) ?? 0) - ((totals[target] ?? 0) * k) / twiceTotal;

      let best = own;
      let bestGain = gain(own);
      for (const target of [...links.keys()].sort((x, y) => x - y)) {
        const value = gain(target);
        if (value > bestGain + EPSILON) {
          best = target;
          bestGain = value;
        }
      }
      totals[best] = (totals[best] ?? 0) + k;
      if (best !== own) {
        community[node] = best;
        improved = true;
        moved = true;
      }
    }
  }

  const renumber = new Map<number, number>();
  return {
    community: community.map((value) => {
      if (!renumber.has(value)) renumber.set(value, renumber.size);
      return renumber.get(value) ?? 0;
    }),
    moved,
  };
}

/** The graph of communities: one node per community, edge weights summed. */
function aggregate(graph: Graph, community: readonly number[]): Graph {
  const size = Math.max(0, ...community) + 1;
  const edges: [number, number, number][] = [];
  graph.forEach((neighbours, node) => {
    for (const [other, weight] of neighbours) {
      // Every edge is stored twice (once per end); keep one copy, self loops as they are.
      if (other < node) continue;
      edges.push([community[node] ?? 0, community[other] ?? 0, weight]);
    }
  });
  return buildGraph(size, edges);
}

/**
 * Community of every node: 0 is the largest group, then by size; equal sizes are ordered by
 * their smallest member id. Nodes without an edge are a group of their own.
 */
export function detectCommunities(
  nodes: readonly number[],
  edges: readonly WeightedEdge[],
): Map<number, number> {
  const ids = [...new Set([...nodes, ...edges.flatMap((edge) => [edge.a, edge.b])])].sort(
    (x, y) => x - y,
  );
  const index = new Map(ids.map((id, i) => [id, i]));
  let graph = buildGraph(
    ids.length,
    edges.map((edge) => [index.get(edge.a) ?? 0, index.get(edge.b) ?? 0, edge.weight]),
  );

  // membership[i] = community of original node i at the current level.
  let membership = ids.map((_, i) => i);
  for (;;) {
    const { community, moved } = moveNodes(graph);
    if (!moved) break;
    membership = membership.map((node) => community[node] ?? 0);
    graph = aggregate(graph, community);
  }

  // Final numbering: by size, then by smallest member.
  const members = new Map<number, number[]>();
  membership.forEach((group, i) => {
    const list = members.get(group) ?? [];
    list.push(ids[i] ?? 0);
    members.set(group, list);
  });
  const order = [...members.entries()].sort(
    ([, x], [, y]) => y.length - x.length || (x[0] ?? 0) - (y[0] ?? 0),
  );
  const result = new Map<number, number>();
  order.forEach(([, list], rank) => {
    for (const id of list) result.set(id, rank);
  });
  return result;
}
