import type { AppDatabase } from '../db/client.js';
import { recordServerMinute, upsertChannels } from '../db/repositories/index.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Connection } from '../ts3/connection.js';
import type { Ts3Client, Ts3ClientLeft, Ts3ClientMoved } from '../ts3/types.js';
import type { CountryLookup } from '../geoip/country-lookup.js';
import { ActivityTracker } from './activity.js';
import { IpProcessor } from './ip-processor.js';
import {
  recoverOpenSessions,
  resolveResume,
  writeHeartbeat,
  type RecoveryResult,
} from './recovery.js';
import { loadActivitySettings } from './settings.js';
import { SessionTracker } from './tracker.js';
import type { LiveState } from '../domain/activity.js';

/** A client that is online right now, as known to the watcher. */
export interface LiveClient {
  userId: number;
  nickname: string;
  channelId: number;
  state: LiveState | undefined;
  /** Session start (UTC seconds). */
  since: number;
}

export interface WatcherDeps {
  database: AppDatabase;
  connection: Ts3Connection;
  logger: Logger;
  /** Current time in UTC seconds (injectable for tests). */
  now?: () => number;
  /** Seconds between client-list polls (default 60). */
  pollIntervalS?: number;
  /** Minimum seconds between batched segment writes (default 300). */
  flushIntervalS?: number;
  /** Poll on a timer (default true); tests call `sync()` themselves. */
  autoPoll?: boolean;
  /**
   * Restarts shorter than this keep the sessions of clients that stayed online (default 300 s,
   * 0 disables resuming).
   */
  resumeGraceS?: number;
  /** IP pseudonymisation on join (T2.5); disabled when omitted. */
  ip?: { countries: CountryLookup; hmacSecret: string };
}

/**
 * Wires TS3 connection events to the session and activity trackers and polls the client list
 * (nick changes, activity state, missed events, online count).
 */
export class Watcher {
  readonly tracker: SessionTracker;
  readonly activity: ActivityTracker;
  readonly ip: IpProcessor | undefined;
  private pollTimer: NodeJS.Timeout | undefined;
  private lastFlushAt: number | undefined;
  private syncing: Promise<void> | undefined;
  private readonly now: () => number;
  /** When the query connection was lost; clients gone meanwhile are closed at this time. */
  private lostAt: number | undefined;
  private readonly detach: (() => void)[] = [];
  /** Clients with events while a sync is fetching lists (see `SessionTracker.sync`). */
  private touchedDuringSync: Set<number> | undefined;
  /** Outcome of the start-up recovery; resume candidates are decided by the first sync. */
  private recovery: RecoveryResult | undefined;

  constructor(private readonly deps: WatcherDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.tracker = new SessionTracker(deps.database, deps.logger);
    this.activity = new ActivityTracker(deps.database, () =>
      loadActivitySettings(deps.database.db),
    );
    this.tracker.addListener(this.activity);
    this.ip = deps.ip
      ? new IpProcessor({
          database: deps.database,
          connection: deps.connection,
          logger: deps.logger,
          ...deps.ip,
        })
      : undefined;
    if (this.ip) this.tracker.addListener(this.ip);
  }

  start(): void {
    const { connection } = this.deps;
    // Handle what the previous run left open before tracking anything new (T2.4, T2.7).
    this.recovery = recoverOpenSessions(this.deps.database, this.deps.logger, {
      now: this.now(),
      resumeGraceS: this.resumeGraceS,
    });
    const onConnect = (client: Ts3Client) => {
      this.touchedDuringSync?.add(client.clid);
      this.safely(() => this.tracker.join(client, this.now()));
    };
    const onDisconnect = (event: Ts3ClientLeft) => {
      this.touchedDuringSync?.add(event.clid);
      this.safely(() => {
        this.tracker.leave(event.clid, this.now());
      });
    };
    const onMoved = (event: Ts3ClientMoved) => {
      this.touchedDuringSync?.add(event.clid);
      this.safely(() => {
        this.tracker.move(event.clid, event.channelId, this.now());
      });
    };
    const onLost = () => {
      this.lostAt ??= this.now();
    };
    const onConnected = () => {
      void this.sync();
    };
    connection.on('clientConnect', onConnect);
    connection.on('clientDisconnect', onDisconnect);
    connection.on('clientMoved', onMoved);
    connection.on('disconnected', onLost);
    connection.on('connected', onConnected);
    this.detach.push(() => {
      connection.off('clientConnect', onConnect);
      connection.off('clientDisconnect', onDisconnect);
      connection.off('clientMoved', onMoved);
      connection.off('disconnected', onLost);
      connection.off('connected', onConnected);
    });
    if (connection.isConnected) void this.sync();
    if (this.deps.autoPoll === false) return;
    const intervalMs = (this.deps.pollIntervalS ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      if (connection.isConnected) void this.sync();
    }, intervalMs);
  }

  /**
   * One poll: reads channel and client lists, reconciles sessions (missed events, nick changes),
   * updates activity segments, records the online count and flushes segments when due.
   * Runs on (re)connect and every poll interval; concurrent calls share one run.
   */
  sync(): Promise<void> {
    this.syncing ??= this.runSync().finally(() => {
      this.syncing = undefined;
    });
    return this.syncing;
  }

  private async runSync(): Promise<void> {
    const { connection, database, logger } = this.deps;
    const touched = new Set<number>();
    this.touchedDuringSync = touched;
    try {
      const [channels, clients] = await Promise.all([
        connection.channelList(),
        connection.clientList(),
      ]);
      const at = this.now();
      database.sqlite.transaction(() => {
        upsertChannels(
          database.db,
          channels.map((c) => ({ id: c.cid, name: c.name, seenAt: at })),
        );
      })();
      const recovery = this.recovery;
      if (recovery && recovery.candidates.length > 0) {
        this.recovery = undefined;
        const resumed = resolveResume(database, recovery.candidates, clients, at, {
          heartbeat: recovery.heartbeat,
          resumeGraceS: this.resumeGraceS,
        });
        for (const { client, candidate } of resumed) this.tracker.resume(client, candidate, at);
        logger.info(
          { resumed: resumed.length, closed: recovery.candidates.length - resumed.length },
          'Sessions after restart resolved',
        );
      }
      this.ip?.beginBatch();
      try {
        this.tracker.sync(clients, at, this.lostAt ?? at, touched);
      } finally {
        this.ip?.endBatch();
      }
      this.lostAt = undefined;
      this.activity.observe(clients, (clid) => this.tracker.get(clid), at, touched);
      recordServerMinute(database.db, at, this.tracker.onlineClients.length);
      writeHeartbeat(database.db, at);
      this.lastFlushAt ??= at;
      if (at - this.lastFlushAt >= (this.deps.flushIntervalS ?? 300)) this.flush(at);
      logger.debug({ online: this.tracker.onlineClients.length }, 'Client list synchronized');
    } catch (error) {
      logger.warn({ err: error }, 'Client list synchronization failed');
    } finally {
      if (this.touchedDuringSync === touched) this.touchedDuringSync = undefined;
    }
  }

  /** Client ids of a user's current connections (a player may be connected more than once). */
  clidsOf(userId: number): number[] {
    return this.tracker.onlineClients.filter((c) => c.userId === userId).map((c) => c.clid);
  }

  /** Who is online right now (live, not the buffered segments). */
  liveClients(): LiveClient[] {
    return this.tracker.onlineClients.map((client) => ({
      userId: client.userId,
      nickname: client.nickname,
      channelId: client.channelId,
      state: this.activity.stateOf(client.clid),
      since: client.joinedAt,
    }));
  }

  /** Writes pending activity segments. */
  flush(at = this.now()): void {
    this.activity.flush();
    this.lastFlushAt = at;
  }

  private get resumeGraceS(): number {
    return this.deps.resumeGraceS ?? 300;
  }

  /**
   * Detaches from the connection and writes pending segments. Sessions stay open so a quick
   * restart can continue them (T2.7); with resuming disabled they are closed.
   */
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
    for (const off of this.detach.splice(0)) off();
    const now = this.now();
    if (this.resumeGraceS === 0) {
      this.tracker.closeAll(now);
    } else if (this.deps.connection.isConnected && this.lostAt === undefined) {
      // The view is current up to now: extend open segments and mark the moment.
      this.activity.touchAll(now);
      writeHeartbeat(this.deps.database.db, now);
    }
    this.flush(now);
  }

  private safely(fn: () => unknown): void {
    try {
      fn();
    } catch (error) {
      this.deps.logger.error({ err: error }, 'Failed to process TS3 event');
    }
  }
}
