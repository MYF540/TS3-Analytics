import { finalizeSession } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import { openSession, recordNickname, upsertUser } from '../db/repositories/index.js';
import { users } from '../db/schema.js';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from '../logging/logger.js';
import { CLIENT_TYPE_QUERY, type Ts3Client } from '../ts3/types.js';

/** A client currently online, as known to the tracker. */
export interface OnlineClient {
  clid: number;
  uid: string;
  userId: number;
  sessionId: number;
  nickname: string;
  channelId: number;
  joinedAt: number;
}

export interface TrackerListener {
  /** Called after a session was opened (client joined or discovered by a sync). */
  onJoined?(client: OnlineClient, source: Ts3Client, at: number): void;
  /** Called after an existing session was resumed following a short restart (T2.7). */
  onResumed?(client: OnlineClient, source: Ts3Client, at: number): void;
  /** Called after the client moved to another channel. */
  onMoved?(client: OnlineClient, previousChannelId: number, at: number): void;
  /** Called before the session is closed. */
  onLeaving?(client: OnlineClient, at: number): void;
  /**
   * Around a client-list sync: joins in between were discovered by the sync (start-up, missed
   * events), not reported by a join event.
   */
  onSyncStart?(): void;
  onSyncEnd?(): void;
}

/**
 * Turns join/leave/move events and client-list snapshots into users, nicknames and sessions.
 * Users are identified by UID only (rule 3); query clients are ignored (rule 4).
 */
export class SessionTracker {
  private readonly online = new Map<number, OnlineClient>();
  private readonly listeners: TrackerListener[] = [];

  constructor(
    private readonly database: AppDatabase,
    private readonly logger: Logger,
  ) {}

  addListener(listener: TrackerListener): void {
    this.listeners.push(listener);
  }

  get onlineClients(): readonly OnlineClient[] {
    return [...this.online.values()];
  }

  get(clid: number): OnlineClient | undefined {
    return this.online.get(clid);
  }

  /** Continues an open session of a client that stayed online during a short restart (T2.7). */
  resume(
    client: Ts3Client,
    session: { sessionId: number; userId: number; joinAt: number },
    at: number,
  ): OnlineClient {
    const tracked: OnlineClient = {
      clid: client.clid,
      uid: client.uid,
      userId: session.userId,
      sessionId: session.sessionId,
      nickname: client.nickname,
      channelId: client.channelId,
      joinedAt: session.joinAt,
    };
    recordNickname(this.database.db, session.userId, client.nickname, at);
    this.online.set(client.clid, tracked);
    for (const l of this.listeners) l.onResumed?.(tracked, client, at);
    return tracked;
  }

  join(client: Ts3Client, at: number): OnlineClient | undefined {
    if (client.type === CLIENT_TYPE_QUERY) return undefined;
    const existing = this.online.get(client.clid);
    if (existing) {
      if (existing.uid === client.uid) return existing;
      // clid was reused by a different client: the old one must have left unnoticed.
      this.leave(client.clid, at);
    }

    const tracked = this.database.sqlite.transaction(() => {
      const userId = upsertUser(this.database.db, {
        uid: client.uid,
        seenAt: at,
        dbid: client.dbid,
        platform: client.platform || undefined,
        version: client.version || undefined,
        country: client.country,
      });
      recordNickname(this.database.db, userId, client.nickname, at);
      const sessionId = openSession(this.database.db, userId, at);
      return {
        clid: client.clid,
        uid: client.uid,
        userId,
        sessionId,
        nickname: client.nickname,
        channelId: client.channelId,
        joinedAt: at,
      };
    })();
    this.online.set(client.clid, tracked);
    this.logger.debug({ uid: client.uid, clid: client.clid }, 'Client joined');
    for (const l of this.listeners) l.onJoined?.(tracked, client, at);
    return tracked;
  }

  leave(clid: number, at: number): void {
    const tracked = this.online.get(clid);
    if (!tracked) return; // unknown clid, e.g. a query client
    for (const l of this.listeners) l.onLeaving?.(tracked, at);
    this.online.delete(clid);
    this.database.sqlite.transaction(() => {
      finalizeSession(this.database, tracked.sessionId, at);
      this.database.db
        .update(users)
        .set({ lastSeen: sql`max(${users.lastSeen}, ${at})` })
        .where(eq(users.id, tracked.userId))
        .run();
    })();
    this.logger.debug({ uid: tracked.uid, clid }, 'Client left');
  }

  move(clid: number, channelId: number, at: number): void {
    const tracked = this.online.get(clid);
    if (!tracked || tracked.channelId === channelId) return;
    const previous = tracked.channelId;
    tracked.channelId = channelId;
    for (const l of this.listeners) l.onMoved?.(tracked, previous, at);
  }

  /**
   * Reconciles the tracked state with a complete client list taken at `at`.
   * Clients missing from the list are closed at `goneAt` (defaults to `at`), e.g. the moment the
   * query connection was lost, so outages do not inflate online time.
   * Clients in `skip` had events while the list was being fetched; those events are newer than
   * the snapshot, so they are left alone (otherwise someone who just left would be re-opened).
   */
  sync(
    clients: readonly Ts3Client[],
    at: number,
    goneAt = at,
    skip: ReadonlySet<number> = new Set(),
  ): void {
    const present = new Map(
      clients.filter((c) => c.type !== CLIENT_TYPE_QUERY).map((c) => [c.clid, c]),
    );
    for (const clid of skip) present.delete(clid);
    for (const l of this.listeners) l.onSyncStart?.();
    try {
      for (const tracked of [...this.online.values()]) {
        if (skip.has(tracked.clid)) continue;
        const current = present.get(tracked.clid);
        if (!current || current.uid !== tracked.uid) this.leave(tracked.clid, goneAt);
      }
      for (const client of present.values()) {
        const tracked = this.online.get(client.clid);
        if (!tracked) {
          this.join(client, at);
          continue;
        }
        if (client.nickname !== tracked.nickname) {
          recordNickname(this.database.db, tracked.userId, client.nickname, at);
          tracked.nickname = client.nickname;
        }
        this.move(client.clid, client.channelId, at);
      }
    } finally {
      for (const l of this.listeners) l.onSyncEnd?.();
    }
  }

  /** Closes all tracked sessions (shutdown). */
  closeAll(at: number): void {
    for (const clid of [...this.online.keys()]) this.leave(clid, at);
  }
}
