import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import { scrubIps, type Logger } from '../logging/logger.js';

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

export interface JobStatus {
  name: string;
  intervalS: number;
  lastRun: number | undefined;
  /** When the job is due next (it runs at the first check after this time). */
  nextRun: number;
  /** Failure of the last run in this process, if it failed. */
  lastError: { at: number; message: string } | undefined;
}

const lastRunKey = (name: string) => `jobs.${name}.lastRun`;

/**
 * Runs periodic jobs. Last run times live in `settings`, so the rhythm survives restarts and a
 * job that was due while the service was down runs right after the next start.
 */
export class JobRunner {
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;
  private readonly errors = new Map<string, { at: number; message: string }>();
  private readonly running = new Set<string>();
  private readonly pending = new Set<Promise<void>>();

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

  /** Resolves when running asynchronous jobs are done (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.pending]);
  }

  private succeeded(name: string, result: unknown): void {
    this.errors.delete(name);
    this.deps.logger.info({ job: name, result }, 'Job finished');
  }

  private failed(name: string, at: number, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    this.errors.set(name, { at, message: scrubIps(message).slice(0, 300) });
    this.deps.logger.error({ err: error, job: name }, 'Job failed');
  }

  status(): JobStatus[] {
    return this.jobs.map((job) => {
      const lastRun = this.lastRun(job.name);
      return {
        name: job.name,
        intervalS: job.intervalS,
        lastRun,
        nextRun: lastRun === undefined ? this.now() : lastRun + job.intervalS,
        lastError: this.errors.get(job.name),
      };
    });
  }

  /** Runs every job whose interval has passed. Returns the names of the jobs that ran. */
  runDue(): string[] {
    const ran: string[] = [];
    for (const job of this.jobs) {
      const now = this.now();
      const last = this.lastRun(job.name);
      if (last !== undefined && now - last < job.intervalS) continue;
      if (this.running.has(job.name)) continue;
      try {
        const result = job.run(now);
        if (result instanceof Promise) {
          // Asynchronous job (e.g. backup): report when it is done, never run it twice at once.
          this.running.add(job.name);
          const tracked = result.then(
            (value: unknown) => {
              this.succeeded(job.name, value);
            },
            (error: unknown) => {
              this.failed(job.name, now, error);
            },
          );
          this.pending.add(tracked);
          void tracked.finally(() => {
            this.running.delete(job.name);
            this.pending.delete(tracked);
          });
        } else {
          this.succeeded(job.name, result);
        }
      } catch (error) {
        this.failed(job.name, now, error);
      }
      // Also recorded after a failure, so a broken job does not run every ten minutes.
      setSetting(this.deps.db, lastRunKey(job.name), now, now);
      ran.push(job.name);
    }
    return ran;
  }
}
