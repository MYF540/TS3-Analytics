import { describe, expect, it } from 'vitest';
import { detectCommunities, type WeightedEdge } from './communities.js';

/** Every pair of the given nodes, with one weight. */
function clique(ids: number[], weight: number): WeightedEdge[] {
  const edges: WeightedEdge[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      edges.push({ a: ids[i] ?? 0, b: ids[j] ?? 0, weight });
    }
  }
  return edges;
}

const groups = (result: Map<number, number>) => {
  const byGroup = new Map<number, number[]>();
  for (const [id, group] of result) byGroup.set(group, [...(byGroup.get(group) ?? []), id]);
  return [...byGroup.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, ids]) => ids.sort((x, y) => x - y));
};

describe('detectCommunities', () => {
  it('separates two groups joined by a weak bridge, the larger one first', () => {
    const edges = [
      ...clique([1, 2, 3], 3600),
      ...clique([10, 11, 12, 13], 3600),
      { a: 3, b: 10, weight: 60 },
    ];
    expect(groups(detectCommunities([], edges))).toEqual([
      [10, 11, 12, 13],
      [1, 2, 3],
    ]);
  });

  it('keeps one tight group together', () => {
    const result = detectCommunities([], clique([4, 5, 6, 7, 8], 100));
    expect(new Set(result.values())).toEqual(new Set([0]));
    expect(result.size).toBe(5);
  });

  it('follows the weights, not only the links', () => {
    // A square where two opposite sides are strong: two pairs.
    const edges = [
      { a: 1, b: 2, weight: 1000 },
      { a: 3, b: 4, weight: 1000 },
      { a: 2, b: 3, weight: 1 },
      { a: 4, b: 1, weight: 1 },
    ];
    expect(groups(detectCommunities([], edges))).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it('gives nodes without an edge a group of their own', () => {
    const result = detectCommunities([1, 2, 9], [{ a: 1, b: 2, weight: 10 }]);
    expect(groups(result)).toEqual([[1, 2], [9]]);
  });

  it('handles an empty network', () => {
    expect(detectCommunities([], []).size).toBe(0);
  });

  it('gives the same result whatever order the edges come in', () => {
    const edges = [
      ...clique([1, 2, 3, 4], 500),
      ...clique([20, 21, 22], 500),
      ...clique([40, 41, 42], 400),
      { a: 4, b: 20, weight: 30 },
      { a: 22, b: 40, weight: 30 },
    ];
    const forward = detectCommunities([], edges);
    const backward = detectCommunities([], [...edges].reverse());
    expect(backward).toEqual(forward);
    expect(groups(forward)).toEqual([
      [1, 2, 3, 4],
      [20, 21, 22],
      [40, 41, 42],
    ]);
  });
});
