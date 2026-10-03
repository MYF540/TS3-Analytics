/**
 * Channel creator (T10.6): keeps a set number of empty channels below a parent channel.
 * Pure planning – what to create and what to delete; no I/O.
 */

export interface PoolChannel {
  cid: number;
  name: string;
  /** Id of the channel this one is sorted after (0 = first). */
  order: number;
  /** Clients inside, as far as the bot sees them. */
  clients: number;
  /** Created or adopted by the channel creator; only these are ever deleted. */
  managed: boolean;
}

export type PoolNaming =
  { kind: 'numbered'; prefix: string } | { kind: 'list'; names: readonly string[] };

export interface PoolRules {
  naming: PoolNaming;
  /** Empty channels that should always be there. */
  minFree: number;
  /** Upper bound for managed channels in this area. */
  maxChannels: number;
}

export interface PoolPlan {
  create: { name: string; /** Sort after this channel (0 = first). */ order: number }[];
  /** Channel ids, all of them managed and empty. */
  delete: number[];
}

/** TS3 limit for channel names. */
export const CHANNEL_NAME_MAX = 40;

export function numberedName(prefix: string, number: number): string {
  return `${prefix} ${String(number)}`.slice(0, CHANNEL_NAME_MAX);
}

/**
 * Position of a name in the naming scheme (1-based number or list position), undefined when
 * the name does not belong to it.
 */
export function rankOf(name: string, naming: PoolNaming): number | undefined {
  if (naming.kind === 'list') {
    const index = naming.names.indexOf(name);
    return index === -1 ? undefined : index + 1;
  }
  const lead = `${naming.prefix} `;
  if (!name.startsWith(lead)) return undefined;
  const rest = name.slice(lead.length);
  return /^[1-9]\d{0,3}$/.test(rest) ? Number(rest) : undefined;
}

function nameAt(rank: number, naming: PoolNaming): string | undefined {
  return naming.kind === 'list' ? naming.names[rank - 1] : numberedName(naming.prefix, rank);
}

/** The child no other child is sorted after, i.e. the last one in the client's tree. */
function lastChild(children: readonly PoolChannel[]): number {
  const predecessors = new Set(children.map((child) => child.order));
  return children.find((child) => !predecessors.has(child.cid))?.cid ?? 0;
}

/**
 * What has to change so that exactly `minFree` managed channels are empty. New channels take
 * the lowest free names; of several surplus channels the highest-ranked ones go first. Names
 * taken by channels the module does not manage are skipped, those channels are never touched.
 */
export function planPool(children: readonly PoolChannel[], rules: PoolRules): PoolPlan {
  const managed = children.filter((child) => child.managed);
  const free = managed.filter((child) => child.clients === 0);
  const plan: PoolPlan = { create: [], delete: [] };

  if (free.length > rules.minFree) {
    const rank = (child: PoolChannel) => rankOf(child.name, rules.naming) ?? Infinity;
    const surplus = [...free].sort((a, b) => rank(b) - rank(a) || b.cid - a.cid);
    plan.delete = surplus.slice(0, free.length - rules.minFree).map((child) => child.cid);
    return plan;
  }

  const taken = new Set(children.map((child) => child.name));
  const wanted = Math.min(rules.minFree - free.length, rules.maxChannels - managed.length);
  const limit = rules.naming.kind === 'list' ? rules.naming.names.length : 9999;
  for (let rank = 1; rank <= limit && plan.create.length < wanted; rank++) {
    const name = nameAt(rank, rules.naming);
    if (name === undefined || name === '' || taken.has(name)) continue;
    taken.add(name);
    // After the managed channel ranked just below, so "Talk 2" follows "Talk 1".
    const before = managed
      .map((child) => ({ child, rank: rankOf(child.name, rules.naming) }))
      .filter((entry): entry is { child: PoolChannel; rank: number } => entry.rank !== undefined)
      .filter((entry) => entry.rank < rank)
      .sort((a, b) => b.rank - a.rank)[0];
    plan.create.push({ name, order: before?.child.cid ?? lastChild(children) });
  }
  return plan;
}

/** Children of the parent that fit the naming scheme and are not managed yet. */
export function adoptable(children: readonly PoolChannel[], naming: PoolNaming): PoolChannel[] {
  return children.filter((child) => !child.managed && rankOf(child.name, naming) !== undefined);
}
