/**
 * What the network page shows (T12.2): which category every player falls into for the chosen
 * colour, and which players and connections remain after the filters. Pure functions, so the
 * page and its tests share them.
 */
import type { NetworkGraph } from '../api/types';
import { t } from '../i18n';
import type { ChartPalette } from './palette';

export const COLOR_MODES = ['community', 'rank', 'country', 'activity'] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

export interface Category {
  key: string;
  label: string;
  color: string;
  /** Players of the whole answer in this category – counted before filtering. */
  count: number;
}

export interface Categorized {
  categories: Category[];
  of: Map<number, string>;
}

type Node = NetworkGraph['nodes'][number];

const OTHER = 'other';
const UNKNOWN = 'unknown';
const DAY = 86_400;

/** Up to three named categories in colour; the rest is folded into "other" (grey). */
function topThree(
  nodes: readonly Node[],
  keyOf: (node: Node) => string | null,
  labelOf: (key: string, index: number) => string,
  order: (a: [string, number], b: [string, number]) => number,
  palette: ChartPalette,
): Categorized {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = keyOf(node);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const named = [...counts.entries()].sort(order).slice(0, 3);
  const colour = new Map(named.map(([key], index) => [key, palette.categories[index] ?? '']));
  const of = new Map<number, string>();
  for (const node of nodes) {
    const key = keyOf(node);
    of.set(node.userId, key === null ? UNKNOWN : colour.has(key) ? key : OTHER);
  }
  const categories: Category[] = named.map(([key, count], index) => ({
    key,
    label: labelOf(key, index),
    color: colour.get(key) ?? '',
    count,
  }));
  return withRest(categories, of, palette);
}

/** Appends "other" and "unknown" when somebody falls into them. */
function withRest(
  categories: Category[],
  of: Map<number, string>,
  palette: ChartPalette,
): Categorized {
  const count = (key: string) => [...of.values()].filter((value) => value === key).length;
  for (const [key, label] of [
    [OTHER, t('network.color.other')],
    [UNKNOWN, t('network.color.unknown')],
  ] as const) {
    const n = count(key);
    if (n > 0) categories.push({ key, label, color: palette.other, count: n });
  }
  return { categories, of };
}

/** Last seen within a week, within a month, or longer ago – an ordered scale. */
function activity(nodes: readonly Node[], now: number, palette: ChartPalette): Categorized {
  const steps = [
    { key: 'recent', label: t('network.activity.recent'), within: 7 * DAY },
    { key: 'away', label: t('network.activity.away'), within: 30 * DAY },
    { key: 'gone', label: t('network.activity.gone'), within: Number.POSITIVE_INFINITY },
  ];
  const of = new Map<number, string>();
  for (const node of nodes) {
    const step = steps.find((candidate) => now - node.lastSeen <= candidate.within);
    of.set(node.userId, step?.key ?? 'gone');
  }
  const categories = steps.map((step, index) => ({
    key: step.key,
    label: step.label,
    color: palette.ordinal[index] ?? '',
    count: [...of.values()].filter((value) => value === step.key).length,
  }));
  return { categories, of };
}

/**
 * The rank ladder in three ordered tiers, highest first, each labelled with the ranks it holds.
 * Three steps stay readable; one colour per rank would not with a long ladder.
 */
function rankTiers(data: NetworkGraph, palette: ChartPalette): Categorized {
  const ladder = data.ranks;
  const tierOf = new Map<number, number>();
  const tiers = Math.min(3, ladder.length);
  ladder.forEach((rank, index) => {
    // Lowest rank first in the ladder; tier 0 holds the highest ranks.
    tierOf.set(rank.id, tiers - 1 - Math.floor((index * tiers) / ladder.length));
  });
  const of = new Map<number, string>();
  for (const node of data.nodes) {
    const tier = node.rankId === null ? undefined : tierOf.get(node.rankId);
    of.set(node.userId, tier === undefined ? UNKNOWN : `tier${String(tier)}`);
  }
  const categories: Category[] = [];
  for (let tier = 0; tier < tiers; tier++) {
    const names = ladder.filter((rank) => tierOf.get(rank.id) === tier).map((rank) => rank.name);
    const label =
      names.length === 1 ? (names[0] ?? '') : `${names.at(-1) ?? ''} – ${names[0] ?? ''}`;
    categories.push({
      key: `tier${String(tier)}`,
      label,
      color: palette.ordinal[tier] ?? '',
      count: [...of.values()].filter((value) => value === `tier${String(tier)}`).length,
    });
  }
  const result = withRest(categories, of, palette);
  // "unknown" means "no rank" here.
  for (const category of result.categories) {
    if (category.key === UNKNOWN) category.label = t('network.color.noRank');
  }
  return result;
}

/** The categories of the chosen colour mode. Computed on the whole answer, so a filter never repaints. */
export function categorize(
  data: NetworkGraph,
  mode: ColorMode,
  palette: ChartPalette,
  now: number,
): Categorized {
  const bySizeThenKey = (a: [string, number], b: [string, number]) =>
    b[1] - a[1] || a[0].localeCompare(b[0]);
  switch (mode) {
    case 'community':
      // The colours go to the groups with the most players in view: the largest groups of the
      // whole window may hardly appear among the strongest connections. Hiding a group in the
      // legend does not recolour the rest (that filter runs after this).
      return topThree(
        data.nodes,
        (node) => (node.community === null ? null : String(node.community)),
        (_key, index) => t('network.color.group', { number: index + 1 }),
        (a, b) => b[1] - a[1] || Number(a[0]) - Number(b[0]),
        palette,
      );
    case 'country':
      return topThree(
        data.nodes,
        (node) => node.country?.toUpperCase() ?? null,
        (key) => key,
        bySizeThenKey,
        palette,
      );
    case 'rank':
      return rankTiers(data, palette);
    case 'activity':
      return activity(data.nodes, now, palette);
  }
}

export interface NetworkFilter {
  /** Category keys switched off in the legend. */
  hidden: ReadonlySet<string>;
  /** Only members of this server group; null = everybody. */
  groupId: number | null;
  /** A player who stays even without connections (the focus of the search). */
  keep?: number | undefined;
}

/**
 * Players and connections left after the filters. Connections to a hidden player go with them,
 * and players left without any connection are dropped too – lonely dots say nothing.
 */
export function filterGraph(
  data: NetworkGraph,
  categorized: Categorized,
  filter: NetworkFilter,
): NetworkGraph {
  const visible = new Set(
    data.nodes
      .filter((node) => !filter.hidden.has(categorized.of.get(node.userId) ?? UNKNOWN))
      .filter((node) => filter.groupId === null || node.serverGroups.includes(filter.groupId))
      .map((node) => node.userId),
  );
  const edges = data.edges.filter((edge) => visible.has(edge.a) && visible.has(edge.b));
  const connected = new Set(edges.flatMap((edge) => [edge.a, edge.b]));
  if (filter.keep !== undefined && visible.has(filter.keep)) connected.add(filter.keep);
  return {
    ...data,
    nodes: data.nodes.filter((node) => connected.has(node.userId)),
    edges,
  };
}
