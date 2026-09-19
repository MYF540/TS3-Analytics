/**
 * Server-group changes for a rank (T6.3). Only groups of the rank ladder ("managed") are ever
 * added or removed; every other group of the client is left alone (AGENTS.md rule 6).
 */

export interface GroupDiff {
  add: number[];
  remove: number[];
}

export function groupDiff(
  current: readonly number[],
  targetGroupId: number | null,
  managed: ReadonlySet<number>,
): GroupDiff {
  if (targetGroupId !== null && !managed.has(targetGroupId)) {
    throw new Error(`Target group ${String(targetGroupId)} is not a rank group`);
  }
  const held = new Set(current.filter((g) => managed.has(g)));
  return {
    add: targetGroupId !== null && !held.has(targetGroupId) ? [targetGroupId] : [],
    remove: [...held].filter((g) => g !== targetGroupId).sort((a, b) => a - b),
  };
}

export function isEmptyDiff(diff: GroupDiff): boolean {
  return diff.add.length === 0 && diff.remove.length === 0;
}

/** Last-resort guard before any server command: refuses groups outside the ladder. */
export function assertManaged(diff: GroupDiff, managed: ReadonlySet<number>): void {
  for (const group of [...diff.add, ...diff.remove]) {
    if (!managed.has(group)) throw new Error(`Refusing to change unmanaged group ${String(group)}`);
  }
}
