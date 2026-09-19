import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { activitySegments, type ActivityState } from '../schema.js';
import type { DbExecutor, UnixSeconds } from './types.js';

export type ActivitySegment = typeof activitySegments.$inferSelect;

export interface NewSegment {
  userId: number;
  sessionId: number | null;
  channelId: number | null;
  state: ActivityState;
  startAt: UnixSeconds;
}

/** Starts a segment; `end_at` equals `start_at` until it is extended. */
export function openSegment(db: DbExecutor, segment: NewSegment): number {
  return db
    .insert(activitySegments)
    .values({ ...segment, endAt: segment.startAt, isOpen: true })
    .returning({ id: activitySegments.id })
    .get().id;
}

/**
 * Moves `end_at` of open segments forward. Never shortens a segment and ignores closed ones.
 * Call inside a transaction when extending many segments at once.
 */
export function extendSegments(
  db: DbExecutor,
  updates: readonly { id: number; endAt: UnixSeconds }[],
): void {
  for (const { id, endAt } of updates) {
    db.update(activitySegments)
      .set({ endAt })
      .where(
        and(
          eq(activitySegments.id, id),
          eq(activitySegments.isOpen, true),
          lte(activitySegments.endAt, endAt),
        ),
      )
      .run();
  }
}

/**
 * Closes an open segment at `endAt` (never before its current end).
 * Returns the closed segment, or `undefined` if it does not exist or was already closed.
 */
export function closeSegment(
  db: DbExecutor,
  segmentId: number,
  endAt: UnixSeconds,
): ActivitySegment | undefined {
  // Drizzle types `.get()` as always present; it is `undefined` when no row matched.
  const row = db
    .update(activitySegments)
    .set({ endAt: sql`max(${activitySegments.endAt}, ${endAt})`, isOpen: false })
    .where(and(eq(activitySegments.id, segmentId), eq(activitySegments.isOpen, true)))
    .returning()
    .get() as ActivitySegment | undefined;
  return row;
}

export function getOpenSegments(db: DbExecutor): ActivitySegment[] {
  return db
    .select()
    .from(activitySegments)
    .where(eq(activitySegments.isOpen, true))
    .orderBy(asc(activitySegments.startAt))
    .all();
}
