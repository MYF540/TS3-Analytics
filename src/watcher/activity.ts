import { finalizeSegment, recordClosedSegment } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import { extendSegments, openSegment } from '../db/repositories/index.js';
import {
  determineState,
  transitionTime,
  type ActivitySettings,
  type ClientActivity,
  type LiveState,
} from '../domain/activity.js';
import type { Ts3Client } from '../ts3/types.js';
import type { OnlineClient, TrackerListener } from './tracker.js';

interface Segment {
  userId: number;
  sessionId: number;
  channelId: number;
  state: LiveState;
  startAt: number;
  endAt: number;
  /** Row id once the open segment has been written; undefined while only in memory. */
  dbId: number | undefined;
}

function activityOf(client: Ts3Client): ClientActivity {
  return {
    channelId: client.channelId,
    idleMs: client.idleMs,
    away: client.away,
    outputMuted: client.outputMuted,
  };
}

/**
 * Maintains one open activity segment per online client. Segments live in memory and are only
 * extended while state and channel stay the same; any change closes the segment and starts a new
 * one. `flush()` writes everything in one transaction (open segments are stored as open rows so
 * crash recovery can close them; closed ones are folded into the aggregates).
 */
export class ActivityTracker implements TrackerListener {
  private readonly open = new Map<number, Segment>();
  private closed: Segment[] = [];
  private readonly lastActivity = new Map<number, ClientActivity>();

  constructor(
    private readonly database: AppDatabase,
    private readonly settings: () => ActivitySettings,
  ) {}

  /** Current activity state of an online client (undefined if unknown). */
  stateOf(clid: number): LiveState | undefined {
    return this.open.get(clid)?.state;
  }

  get openSegments(): number {
    return this.open.size;
  }

  get pendingClosed(): number {
    return this.closed.length;
  }

  onJoined(client: OnlineClient, source: Ts3Client, at: number): void {
    this.lastActivity.set(client.clid, activityOf(source));
    this.update(client, at, this.settings());
  }

  onResumed(client: OnlineClient, source: Ts3Client, at: number): void {
    this.onJoined(client, source, at);
  }

  /** Extends all open segments to `at` (e.g. right before a clean shutdown). */
  touchAll(at: number): void {
    for (const segment of this.open.values()) segment.endAt = Math.max(segment.endAt, at);
  }

  onMoved(client: OnlineClient, _previousChannelId: number, at: number): void {
    const activity = this.lastActivity.get(client.clid);
    if (activity) activity.channelId = client.channelId;
    this.update(client, at, this.settings());
  }

  onLeaving(client: OnlineClient, at: number): void {
    this.close(client.clid, at);
    this.lastActivity.delete(client.clid);
  }

  /** Applies a client-list snapshot taken at `at` to the tracked (online) clients. */
  observe(
    clients: readonly Ts3Client[],
    online: (clid: number) => OnlineClient | undefined,
    at: number,
    skip: ReadonlySet<number> = new Set(),
  ): void {
    const settings = this.settings();
    for (const client of clients) {
      if (skip.has(client.clid)) continue;
      const tracked = online(client.clid);
      if (!tracked) continue;
      this.lastActivity.set(client.clid, activityOf(client));
      this.update(tracked, at, settings, true);
    }
  }

  /** Writes all pending changes in one transaction. */
  flush(): void {
    const { database } = this;
    const closed = this.closed;
    this.closed = [];
    database.sqlite.transaction(() => {
      this.ensureChannels([...closed, ...this.open.values()], closed.at(-1)?.endAt ?? 0);
      for (const segment of closed) {
        if (segment.dbId === undefined) {
          recordClosedSegment(database, {
            userId: segment.userId,
            sessionId: segment.sessionId,
            channelId: segment.channelId,
            state: segment.state,
            startAt: segment.startAt,
            endAt: segment.endAt,
          });
        } else {
          finalizeSegment(database, segment.dbId, segment.endAt);
        }
      }
      const extend: { id: number; endAt: number }[] = [];
      for (const segment of this.open.values()) {
        const id =
          segment.dbId ??
          openSegment(database.db, {
            userId: segment.userId,
            sessionId: segment.sessionId,
            channelId: segment.channelId,
            state: segment.state,
            startAt: segment.startAt,
          });
        segment.dbId = id;
        extend.push({ id, endAt: segment.endAt });
      }
      extendSegments(database.db, extend);
    })();
  }

  /**
   * Applies the current state. For poll observations (`fromPoll`) an idle/active change without a
   * channel change is dated back using the reported idle time (T2.8); events use their own time.
   */
  private update(
    client: OnlineClient,
    at: number,
    settings: ActivitySettings,
    fromPoll = false,
  ): void {
    const activity = this.lastActivity.get(client.clid);
    const state = activity
      ? determineState({ ...activity, channelId: client.channelId }, settings)
      : 'active';
    const current = this.open.get(client.clid);
    if (current && current.state === state && current.channelId === client.channelId) {
      current.endAt = Math.max(current.endAt, at);
      return;
    }
    let startAt = at;
    if (current && activity && fromPoll && current.channelId === client.channelId) {
      startAt = transitionTime(current.state, state, activity, at, settings, current.endAt);
    }
    if (current) this.close(client.clid, startAt);
    this.open.set(client.clid, {
      userId: client.userId,
      sessionId: client.sessionId,
      channelId: client.channelId,
      state,
      startAt,
      endAt: at,
      dbId: undefined,
    });
  }

  private close(clid: number, at: number): void {
    const segment = this.open.get(clid);
    if (!segment) return;
    this.open.delete(clid);
    segment.endAt = Math.max(segment.endAt, at);
    // Zero-length segments carry no information unless they already exist as a row.
    if (segment.endAt > segment.startAt || segment.dbId !== undefined) this.closed.push(segment);
  }

  /** Segments reference `channels`; add placeholders for channels not seen in a channel list yet. */
  private ensureChannels(segments: readonly Segment[], at: number): void {
    const insert = this.database.sqlite.prepare(
      `INSERT OR IGNORE INTO channels (id, name, last_seen) VALUES (?, ?, ?)`,
    );
    for (const id of new Set(segments.map((s) => s.channelId))) {
      insert.run(id, `Channel ${String(id)}`, at);
    }
  }
}
