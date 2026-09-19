import { z } from 'zod';
import { finalizeSegment, finalizeSession } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import {
  getOpenSegments,
  getOpenSessions,
  getSetting,
  setSetting,
  type DbExecutor,
} from '../db/repositories/index.js';
import type { Logger } from '../logging/logger.js';

export const HEARTBEAT_KEY = 'watcher.heartbeat';

/** Records the last moment the watcher had a verified view of the server. */
export function writeHeartbeat(db: DbExecutor, at: number): void {
  setSetting(db, HEARTBEAT_KEY, at, at);
}

export function readHeartbeat(db: DbExecutor): number | undefined {
  return getSetting(db, HEARTBEAT_KEY, z.number().int());
}

export interface RecoveryResult {
  sessions: number;
  segments: number;
  heartbeat: number | undefined;
}

/**
 * Closes everything a crashed or killed process left open. Sessions and segments end at the last
 * heartbeat (never before their own start or last known end); without a heartbeat they end at the
 * last known point in time. Aggregates are updated as usual. Must run before the watcher starts.
 */
export function recoverOpenSessions(database: AppDatabase, logger: Logger): RecoveryResult {
  const heartbeat = readHeartbeat(database.db);
  const segments = getOpenSegments(database.db);
  const sessions = getOpenSessions(database.db);
  if (segments.length === 0 && sessions.length === 0) {
    return { sessions: 0, segments: 0, heartbeat };
  }

  const lastSegmentEnd = new Map<number, number>();
  database.sqlite.transaction(() => {
    for (const segment of segments) {
      const endAt = Math.max(segment.endAt, heartbeat ?? segment.endAt);
      finalizeSegment(database, segment.id, endAt);
      if (segment.sessionId !== null) {
        lastSegmentEnd.set(
          segment.sessionId,
          Math.max(lastSegmentEnd.get(segment.sessionId) ?? 0, endAt),
        );
      }
    }
    for (const session of sessions) {
      const known = Math.max(session.joinAt, lastSegmentEnd.get(session.id) ?? 0);
      finalizeSession(database, session.id, Math.max(known, heartbeat ?? known));
    }
  })();

  logger.warn(
    { sessions: sessions.length, segments: segments.length, heartbeat },
    'Closed sessions left open by an unclean shutdown',
  );
  return { sessions: sessions.length, segments: segments.length, heartbeat };
}
