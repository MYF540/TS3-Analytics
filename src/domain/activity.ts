/** Activity state rules (pure). */

export type LiveState = 'active' | 'idle' | 'afk';

export interface ActivitySettings {
  /** Seconds without client activity after which a client counts as idle. */
  idleThresholdS: number;
  /** Channels whose members always count as AFK. */
  afkChannelIds: number[];
  /** Clients with the TS3 "away" status count as AFK. */
  awayIsAfk: boolean;
  /** Clients with muted speakers (not listening) count as AFK. */
  outputMutedIsAfk: boolean;
}

export const DEFAULT_ACTIVITY_SETTINGS: ActivitySettings = {
  idleThresholdS: 600,
  afkChannelIds: [],
  awayIsAfk: true,
  outputMutedIsAfk: true,
};

export interface ClientActivity {
  channelId: number;
  /** Milliseconds since the last activity (TS3 `client_idle_time`). */
  idleMs: number;
  away: boolean;
  outputMuted: boolean;
}

/** Priority: afk (channel, away, muted speakers) > idle (threshold) > active. */
export function determineState(client: ClientActivity, settings: ActivitySettings): LiveState {
  if (settings.afkChannelIds.includes(client.channelId)) return 'afk';
  if (settings.awayIsAfk && client.away) return 'afk';
  if (settings.outputMutedIsAfk && client.outputMuted) return 'afk';
  if (client.idleMs >= settings.idleThresholdS * 1000) return 'idle';
  return 'active';
}
