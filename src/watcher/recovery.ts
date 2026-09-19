import { eq } from 'drizzle-orm';
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
import { users } from '../db/schema.js';
import type { Logger } from '../logging/logger.js';
import { CLIENT_TYPE_QUERY, type Ts3Client } from '../ts3/types.js';

export const HEARTBEAT_KEY = 'watcher.heartbeat';

/** Records the last moment the watcher had a verified view of the server. */
export function writeHeartbeat(db: DbExecutor, at: number): void {
  setSetting(db, HEARTBEAT_KEY, at, at);
}

export function readHeartbeat(db: DbExecutor): number | undefined {
  return getSetting(db, HEARTBEAT_KEY, z.number().int());
}

/** An open session that may continue if its client is still online after a short restart. */
export interface ResumeCandidate {
  sessionId: number;
  userId: number;
  uid: string;
  joinAt: number;
}

export interface RecoveryResult {
  /** Sessions closed right away. */
  sessions: number;
  /** Segments closed right away. */
  segments: number;
  heartbeat: number | undefined;
  /** Sessions kept open until the first client list decides (restart within the grace time). */
  candidates: ResumeCandidate[];
}

export interface RecoveryOptions {
  now: number;
  /** Restarts shorter than this (since the last heartbeat) keep sessions of online clients. */
  resumeGraceS: number;
}

function withinGrace(heartbeat: number | undefined, at: number, graceS: number): boolean {
  return heartbeat !== undefined && graceS > 0 && at - heartbeat <= graceS;
}

/**
 * Closes open sessions and segments of the given sessions (all when `sessionIds` is undefined).
 * They end at `endAt(session)`, never before their own start or last known segment end.
 */
function closeOpen(
  database: AppDatabase,
  sessionIds: ReadonlySet<number> | undefined,
  endAt: (known: number) => number,
): { sessions: number; segments: number } {
  const segments = getOpenSegments(database.db).filter(
    (s) => !sessionIds || (s.sessionId !== null && sessionIds.has(s.sessionId)),
  );
  const sessions = getOpenSessions(database.db).filter((s) => !sessionIds || sessionIds.has(s.id));
  const lastSegmentEnd = new Map<number, number>();
  database.sqlite.transaction(() => {
    for (const segment of segments) {
      const end = endAt(segment.endAt);
      finalizeSegment(database, segment.id, end);
      if (segment.sessionId !== null) {
        lastSegmentEnd.set(
          segment.sessionId,
          Math.max(lastSegmentEnd.get(segment.sessionId) ?? 0, end),
        );
      }
    }
    for (const session of sessions) {
      const known = Math.max(session.joinAt, lastSegmentEnd.get(session.id) ?? 0);
      const leaveAt = endAt(known);
      finalizeSession(database, session.id, leaveAt);
      database.db
        .update(users)
        .set({ lastSeen: leaveAt })
        .where(eq(users.id, session.userId))
        .run();
    }
  })();
  return { sessions: sessions.length, segments: segments.length };
}

/**
 * Runs before the watcher starts. After a short restart (last heartbeat within the grace time)
 * open sessions become resume candidates; otherwise everything left open ends at the last
 * heartbeat (or the last known point in time without one) and is folded into the aggregates.
 */
export function recoverOpenSessions(
  database: AppDatabase,
  logger: Logger,
  options: RecoveryOptions = { now: 0, resumeGraceS: 0 },
): RecoveryResult {
  const heartbeat = readHeartbeat(database.db);
  const open = getOpenSessions(database.db);
  if (open.length === 0 && getOpenSegments(database.db).length === 0) {
    return { sessions: 0, segments: 0, heartbeat, candidates: [] };
  }

  if (withinGrace(heartbeat, options.now, options.resumeGraceS)) {
    const uids = new Map(
      database.sqlite
        .prepare(
          `SELECT id, uid FROM users WHERE id IN (SELECT user_id FROM sessions WHERE leave_at IS NULL)`,
        )
        .all()
        .map((r) => [(r as { id: number }).id, (r as { uid: string }).uid]),
    );
    const candidates = open.map((s) => ({
      sessionId: s.id,
      userId: s.userId,
      uid: uids.get(s.userId) ?? '',
      joinAt: s.joinAt,
    }));
    logger.info({ sessions: candidates.length }, 'Short restart: sessions may be resumed');
    return { sessions: 0, segments: 0, heartbeat, candidates };
  }

  const closed = closeOpen(database, undefined, (known) => Math.max(known, heartbeat ?? known));
  logger.warn({ ...closed, heartbeat }, 'Closed sessions left open by a previous run');
  return { ...closed, heartbeat, candidates: [] };
}

export interface Resumed {
  client: Ts3Client;
  candidate: ResumeCandidate;
}

/**
 * Decides the resume candidates with the first client list after a restart: candidates whose UID
 * is still online continue (their open segments end now and new ones start), all others end at
 * the heartbeat. If the first list comes too late, nothing is resumed.
 */
export function resolveResume(
  database: AppDatabase,
  candidates: readonly ResumeCandidate[],
  clients: readonly Ts3Client[],
  at: number,
  options: { heartbeat: number | undefined; resumeGraceS: number },
): Resumed[] {
  const resumed: Resumed[] = [];
  if (withinGrace(options.heartbeat, at, options.resumeGraceS)) {
    const byUid = new Map<string, Ts3Client[]>();
    for (const client of clients) {
      if (client.type === CLIENT_TYPE_QUERY) continue;
      byUid.set(client.uid, [...(byUid.get(client.uid) ?? []), client]);
    }
    for (const candidate of [...candidates].sort((a, b) => a.joinAt - b.joinAt)) {
      const client = byUid.get(candidate.uid)?.shift();
      if (client) resumed.push({ client, candidate });
    }
  }
  const resumedIds = new Set(resumed.map((r) => r.candidate.sessionId));
  const heartbeat = options.heartbeat;
  // Resumed: the state is assumed unchanged during the short downtime; segments end now.
  closeOpenSegmentsOnly(database, resumedIds, at);
  closeOpen(
    database,
    new Set(candidates.map((c) => c.sessionId).filter((id) => !resumedIds.has(id))),
    (known) => Math.max(known, heartbeat ?? known),
  );
  return resumed;
}

function closeOpenSegmentsOnly(
  database: AppDatabase,
  sessionIds: ReadonlySet<number>,
  at: number,
): void {
  if (sessionIds.size === 0) return;
  database.sqlite.transaction(() => {
    for (const segment of getOpenSegments(database.db)) {
      if (segment.sessionId !== null && sessionIds.has(segment.sessionId)) {
        finalizeSegment(database, segment.id, Math.max(segment.endAt, at));
      }
    }
  })();
}
