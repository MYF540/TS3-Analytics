import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import type { Logger } from '../logging/logger.js';

export interface PeriodicJob {
  /** Stable name; the last run is stored as `jobs.<name>.lastRun`. */
  name: string;
  intervalS: number;
  run(now: number): unknown;
}

export interface JobRunnerDeps {
  db: DbExecutor;
  logger: Logger;
  now?: () => number;
  /** How often due jobs are checked (default 10 minutes). */
  checkIntervalMs?: number;
}

const lastRunKey = (name: string) => `jobs.${name}.lastRun`;

/**
 * Runs periodic jobs. Last run times live in `settings`, so the rhythm survives restarts and a
 * job that was due while the service was down runs right after the next start.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(
    private readonly jobs: readonly PeriodicJob[],
    private readonly deps: JobRunnerDeps,
  ) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  }

  start(): void {
    this.runDue();
    this.timer = setInterval(
      () => {
        this.runDue();
      },
      this.deps.checkIntervalMs ?? 10 * 60_000,
    );
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  lastRun(name: string): number | undefined {
    return getSetting(this.deps.db, lastRunKey(name), z.number().int());
  }

  /** Runs every job whose interval has passed. Returns the names of the jobs that ran. */
  runDue(): string[] {
    const ran: string[] = [];
    for (const job of this.jobs) {
      const now = this.now();
      const last = this.lastRun(job.name);
      if (last !== undefined && now - last < job.intervalS) continue;
      try {
        const result = job.run(now);
        this.deps.logger.info({ job: job.name, result }, 'Job finished');
      } catch (error) {
        this.deps.logger.error({ err: error, job: job.name }, 'Job failed');
      }
      // Also recorded after a failure, so a broken job does not run every ten minutes.
      setSetting(this.deps.db, lastRunKey(job.name), now, now);
      ran.push(job.name);
    }
    return ran;
  }
}
