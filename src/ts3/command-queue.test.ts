import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandQueue, QueueClosedError } from './command-queue.js';

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});

afterEach(() => {
  vi.useRealTimers();
});

/** Largest number of start times within any sliding window of `windowMs`. */
function maxInWindow(times: number[], windowMs: number): number {
  let max = 0;
  for (const [i, start] of times.entries()) {
    const count = times.slice(i).filter((t) => t < start + windowMs).length;
    max = Math.max(max, count);
  }
  return max;
}

describe('CommandQueue', () => {
  it('never starts more than the limit within one second', async () => {
    const queue = new CommandQueue(5);
    const starts: number[] = [];
    const done = Array.from({ length: 23 }, (_, i) =>
      queue.run(() => {
        starts.push(Date.now());
        return Promise.resolve(i);
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);

    expect(await Promise.all(done)).toEqual(Array.from({ length: 23 }, (_, i) => i));
    expect(starts).toHaveLength(23);
    expect(maxInWindow(starts, 1000)).toBe(5);
    // 23 commands at 5/s need at least 4 full windows.
    expect((starts.at(-1) ?? 0) - (starts[0] ?? 0)).toBeGreaterThanOrEqual(4000);
  });

  it('respects the limit across bursts that arrive later', async () => {
    const queue = new CommandQueue(3);
    const starts: number[] = [];
    const cmd = () => {
      starts.push(Date.now());
      return Promise.resolve();
    };
    const first = [1, 2, 3].map(() => queue.run(cmd));
    await vi.advanceTimersByTimeAsync(500);
    const second = [1, 2, 3].map(() => queue.run(cmd));
    await vi.advanceTimersByTimeAsync(5000);
    await Promise.all([...first, ...second]);
    expect(maxInWindow(starts, 1000)).toBe(3);
  });

  it('runs commands one at a time in order', async () => {
    const queue = new CommandQueue(100);
    const log: string[] = [];
    const slow = (name: string, ms: number) => () =>
      new Promise<void>((resolve) => {
        log.push(`start ${name}`);
        setTimeout(() => {
          log.push(`end ${name}`);
          resolve();
        }, ms);
      });
    const all = Promise.all([queue.run(slow('a', 50)), queue.run(slow('b', 10))]);
    await vi.advanceTimersByTimeAsync(100);
    await all;
    expect(log).toEqual(['start a', 'end a', 'start b', 'end b']);
  });

  it('keeps going after a failing command', async () => {
    const queue = new CommandQueue(10);
    const failing = queue.run(() => Promise.reject(new Error('boom')));
    const syncThrow = queue.run(() => {
      throw new Error('sync boom');
    });
    const ok = queue.run(() => Promise.resolve('ok'));
    const results = Promise.allSettled([failing, syncThrow, ok]);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected', 'fulfilled']);
  });

  it('rejects waiting commands on clear', async () => {
    const queue = new CommandQueue(1);
    const first = queue.run(() => Promise.resolve(1));
    const second = queue.run(() => Promise.resolve(2));
    const secondResult = second.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    queue.clear();
    await vi.advanceTimersByTimeAsync(2000);
    expect(await first).toBe(1);
    expect(await secondResult).toBeInstanceOf(QueueClosedError);
  });

  it('supports limits below one command per second', async () => {
    const queue = new CommandQueue(0.5);
    const starts: number[] = [];
    const all = [1, 2, 3].map(() =>
      queue.run(() => {
        starts.push(Date.now());
        return Promise.resolve();
      }),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all(all);
    expect(maxInWindow(starts, 2000)).toBe(1);
  });

  it('rejects invalid limits', () => {
    expect(() => new CommandQueue(0)).toThrow(RangeError);
  });
});
