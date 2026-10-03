/** Spam control (T10.9): counting repeated actions in a sliding window. Pure, no I/O. */

/** Counts events per key within the last `windowS` seconds. */
export class SlidingCounter {
  private readonly events = new Map<string, number[]>();

  constructor(private readonly maxKeys = 10_000) {}

  /** Records an event at `at` and returns how many happened within the window, this one included. */
  hit(key: string, at: number, windowS: number): number {
    const recent = (this.events.get(key) ?? []).filter((time) => at - time < windowS);
    recent.push(at);
    if (!this.events.has(key) && this.events.size >= this.maxKeys) this.prune(at, windowS);
    this.events.set(key, recent);
    return recent.length;
  }

  reset(key: string): void {
    this.events.delete(key);
  }

  /** Drops keys without a recent event; everything if that does not free enough room. */
  private prune(at: number, windowS: number): void {
    for (const [key, times] of this.events) {
      if (times.every((time) => at - time >= windowS)) this.events.delete(key);
    }
    if (this.events.size >= this.maxKeys) this.events.clear();
  }
}

export interface SpamThresholds {
  /** Count at which the player is warned; 0 = never. */
  warnAt: number;
  kickAt: number;
  banAt: number;
}

export type SpamStep = 'warn' | 'kick' | 'ban';

/**
 * What the count calls for. Warning and kick fire once, exactly when their threshold is
 * reached; the ban fires from its threshold on, so it cannot be skipped.
 */
export function spamStep(count: number, thresholds: SpamThresholds): SpamStep | undefined {
  if (thresholds.banAt > 0 && count >= thresholds.banAt) return 'ban';
  if (thresholds.kickAt > 0 && count === thresholds.kickAt) return 'kick';
  if (thresholds.warnAt > 0 && count === thresholds.warnAt) return 'warn';
  return undefined;
}

/** True when the thresholds that are switched on rise from warning to kick to ban. */
export function thresholdsAscend(thresholds: SpamThresholds): boolean {
  const active = [thresholds.warnAt, thresholds.kickAt, thresholds.banAt].filter((v) => v > 0);
  return active.every((value, index) => index === 0 || value > (active[index - 1] ?? 0));
}
