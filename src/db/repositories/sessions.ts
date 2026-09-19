import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { sessions, type SessionSource } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

export type Session = typeof sessions.$inferSelect;

export interface ClosedSession {
  id: number;
  userId: number;
  joinAt: UnixSeconds;
  leaveAt: UnixSeconds;
  duration: number;
  source: SessionSource;
}

export function openSession(
  db: DbExecutor,
  userId: number,
  joinAt: UnixSeconds,
  source: SessionSource = 'live',
): number {
  return db.insert(sessions).values({ userId, joinAt, source }).returning({ id: sessions.id }).get()
    .id;
}

/**
 * Closes an open session. A `leaveAt` before `join_at` (clock skew) is clamped to `join_at`.
 * Returns the closed session, or `undefined` if it does not exist or was already closed.
 */
export function closeSession(
  db: DbExecutor,
  sessionId: number,
  leaveAt: UnixSeconds,
): ClosedSession | undefined {
  const leave = sql`max(${sessions.joinAt}, ${leaveAt})`;
  // Drizzle types `.get()` as always present; it is `undefined` when no row matched.
  const row = db
    .update(sessions)
    .set({ leaveAt: leave, duration: sql`${leave} - ${sessions.joinAt}` })
    .where(and(eq(sessions.id, sessionId), isNull(sessions.leaveAt)))
    .returning()
    .get() as Session | undefined;
  if (!row || row.leaveAt === null || row.duration === null) return undefined;
  return { ...row, leaveAt: row.leaveAt, duration: row.duration };
}

export function getOpenSessions(db: DbExecutor): Session[] {
  return db
    .select()
    .from(sessions)
    .where(isNull(sessions.leaveAt))
    .orderBy(asc(sessions.joinAt))
    .all();
}

export function getOpenSessionForUser(db: DbExecutor, userId: number): Session | undefined {
  return db
    .select()
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.leaveAt)))
    .get();
}
