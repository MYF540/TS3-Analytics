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

/**
 * When a state change seen at poll time `at` actually happened. TS3 reports the idle time, so
 * active→idle and idle→active can be dated back; other changes (away, muted, channel) are only
 * known to have happened since the last observation. The result lies in `[notBefore, at]`.
 */
export function transitionTime(
  from: LiveState,
  to: LiveState,
  client: Pick<ClientActivity, 'idleMs'>,
  at: number,
  settings: Pick<ActivitySettings, 'idleThresholdS'>,
  notBefore: number,
): number {
  const idleS = Math.floor(client.idleMs / 1000);
  let t = at;
  if (from === 'active' && to === 'idle') t = at - idleS + settings.idleThresholdS;
  else if (from === 'idle' && to === 'active') t = at - idleS;
  return Math.min(at, Math.max(notBefore, t));
}
