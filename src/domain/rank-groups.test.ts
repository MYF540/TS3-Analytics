import { describe, expect, it } from 'vitest';
import { assertManaged, groupDiff } from './rank-groups.js';

const managed = new Set([10, 11, 12]);

describe('groupDiff', () => {
  it('adds the target and removes other rank groups', () => {
    expect(groupDiff([8, 10], 11, managed)).toEqual({ add: [11], remove: [10] });
    expect(groupDiff([8, 11], 11, managed)).toEqual({ add: [], remove: [] });
    expect(groupDiff([8, 10, 12], null, managed)).toEqual({ add: [], remove: [10, 12] });
  });

  it('never touches groups outside the ladder', () => {
    // Exhaustive over a mix of managed and unmanaged groups.
    const others = [1, 6, 8, 9, 13, 99];
    for (const target of [null, 10, 11, 12]) {
      for (let mask = 0; mask < 1 << 9; mask++) {
        const current = [...others, 10, 11, 12].filter((_, i) => (mask >> i) & 1);
        const diff = groupDiff(current, target, managed);
        for (const g of [...diff.add, ...diff.remove]) expect(managed.has(g)).toBe(true);
        expect(() => {
          assertManaged(diff, managed);
        }).not.toThrow();
      }
    }
  });

  it('refuses unmanaged targets', () => {
    expect(() => groupDiff([], 6, managed)).toThrow();
    expect(() => {
      assertManaged({ add: [6], remove: [] }, managed);
    }).toThrow();
  });
});
