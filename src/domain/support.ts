/** Rules of the support channel (T10.4). Pure functions, no I/O. */

export interface SupportClient {
  clid: number;
  channelId: number;
  serverGroups: readonly number[];
}

/**
 * Team members that can be told about a support request: online, in one of the supporter
 * groups and not parked in an AFK channel.
 */
export function availableSupporters<T extends SupportClient>(
  clients: readonly T[],
  options: { supporterGroupIds: readonly number[]; afkChannelIds: readonly number[] },
): T[] {
  return clients.filter(
    (client) =>
      client.serverGroups.some((group) => options.supporterGroupIds.includes(group)) &&
      !options.afkChannelIds.includes(client.channelId),
  );
}

/** Replaces `{name}` in a text of the settings; BBCode in the name is defused. */
export function fillTemplate(text: string, values: { name: string }): string {
  return text.replaceAll('{name}', values.name.replaceAll('[', '\\['));
}

/**
 * Remembers when a player last asked for support, so that someone hopping in and out of the
 * channel does not poke the whole team every time.
 */
export class Cooldown {
  private readonly last = new Map<number, number>();

  constructor(private readonly max = 5000) {}

  /** True (and remembered) when the key may act at `at`; false while it is cooling down. */
  allow(key: number, at: number, cooldownS: number): boolean {
    const previous = this.last.get(key);
    if (previous !== undefined && at - previous < cooldownS) return false;
    if (this.last.size >= this.max) this.last.clear();
    this.last.set(key, at);
    return true;
  }
}
