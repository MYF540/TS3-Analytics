/**
 * Central queue for all ServerQuery commands (AGENTS.md rule 5). Commands run one after another
 * and at most `perSecond` commands start within any sliding one-second window, so the bot never
 * triggers the server's anti-flood protection.
 */

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const systemClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    }),
};

const WINDOW_MS = 1000;

interface Job {
  run: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

export class QueueClosedError extends Error {
  constructor() {
    super('Command queue was cleared');
    this.name = 'QueueClosedError';
  }
}

export class CommandQueue {
  private readonly jobs: Job[] = [];
  /** Start times of the commands within the current window. */
  private readonly starts: number[] = [];
  private running = false;

  constructor(
    private readonly perSecond: number,
    private readonly clock: Clock = systemClock,
  ) {
    if (!(perSecond > 0)) throw new RangeError('perSecond must be positive');
  }

  get pending(): number {
    return this.jobs.length;
  }

  /** Enqueues a command; resolves or rejects with the command's own result. */
  run<T>(command: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.jobs.push({ run: command, resolve: resolve as (value: unknown) => void, reject });
      void this.drain();
    });
  }

  /** Rejects all waiting commands (e.g. when the connection is lost). */
  clear(): void {
    for (const job of this.jobs.splice(0)) job.reject(new QueueClosedError());
  }

  private async drain(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (this.jobs.length > 0) {
        await this.waitForSlot();
        // Taken only now, so `clear()` can still cancel a command that waited for its slot.
        const job = this.jobs.shift();
        if (!job) break;
        this.starts.push(this.clock.now());
        try {
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async waitForSlot(): Promise<void> {
    // Budget: fractional limits (e.g. 2.5/s) allow floor(limit) starts per window, at least 1.
    const capacity = Math.max(1, Math.floor(this.perSecond));
    const minGap = this.perSecond < 1 ? WINDOW_MS / this.perSecond : 0;
    for (;;) {
      const now = this.clock.now();
      while (this.starts.length > 0 && (this.starts[0] ?? 0) <= now - Math.max(WINDOW_MS, minGap)) {
        this.starts.shift();
      }
      if (this.starts.length < capacity) return;
      const oldest = this.starts[0] ?? now;
      await this.clock.sleep(oldest + Math.max(WINDOW_MS, minGap) - now);
    }
  }
}
