import { serverMinutely } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

/** Stores the online count for the minute containing `at` (overwrites a value for that minute). */
export function recordServerMinute(db: DbExecutor, at: UnixSeconds, online: number): void {
  const ts = at - (at % 60);
  db.insert(serverMinutely)
    .values({ ts, online })
    .onConflictDoUpdate({ target: serverMinutely.ts, set: { online } })
    .run();
}
