import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import type { NetworkRange } from '../db/schema.js';

export const NETWORK_KEY = 'network';
export const NETWORK_STATE_KEY = 'network.state';

export const networkSettingsSchema = z.object({
  /**
   * Channels that say nothing about who belongs together: lobby, waiting room, support.
   * AFK channels of the activity settings are always excluded on top of this.
   */
  excludedChannelIds: z.array(z.number().int().positive()).max(500).default([]),
  /** How many of the most active players are compared; the pair count grows with its square. */
  candidates: z.number().int().min(10).max(500).default(200),
  /** A single meeting shorter than this does not count (seconds). */
  minEncounterS: z.number().int().min(0).max(86_400).default(300),
  /** Pairs below this total are not stored (seconds). */
  minPairS: z.number().int().min(0).max(864_000).default(1800),
});

export type NetworkSettings = z.infer<typeof networkSettingsSchema>;

export const DEFAULT_NETWORK_SETTINGS: NetworkSettings = networkSettingsSchema.parse({});

export function loadNetworkSettings(db: DbExecutor): NetworkSettings {
  return getSetting(db, NETWORK_KEY, networkSettingsSchema) ?? DEFAULT_NETWORK_SETTINGS;
}

export function saveNetworkSettings(
  db: DbExecutor,
  settings: z.input<typeof networkSettingsSchema>,
  now: number,
): void {
  setSetting(db, NETWORK_KEY, networkSettingsSchema.parse(settings), now);
}

/** What the last run of the job produced, for the page and the status view. */
export const networkStateSchema = z.object({
  computedAt: z.number().int().positive(),
  seconds: z.number(),
  ranges: z.record(
    z.string(),
    z.object({
      nodes: z.number().int(),
      edges: z.number().int(),
      droppedPairs: z.number().int(),
      from: z.number().int(),
      to: z.number().int(),
    }),
  ),
});

export type NetworkState = z.infer<typeof networkStateSchema>;
export type NetworkRangeState = NetworkState['ranges'][string];

export function loadNetworkState(db: DbExecutor): NetworkState | undefined {
  return getSetting(db, NETWORK_STATE_KEY, networkStateSchema);
}

export function saveNetworkState(db: DbExecutor, state: NetworkState, now: number): void {
  setSetting(db, NETWORK_STATE_KEY, networkStateSchema.parse(state), now);
}

/** Window of a range, in seconds before `now`; `all` starts at `firstData`. */
export function networkWindow(
  range: NetworkRange,
  now: number,
  firstData: number,
): { from: number; to: number } {
  const spans: Record<Exclude<NetworkRange, 'all'>, number> = {
    '30d': 30 * 86_400,
    '90d': 90 * 86_400,
    '1y': 365 * 86_400,
  };
  return { from: range === 'all' ? Math.min(firstData, now) : now - spans[range], to: now };
}
