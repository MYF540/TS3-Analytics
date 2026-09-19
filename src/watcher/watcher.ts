import type { AppDatabase } from '../db/client.js';
import { upsertChannels } from '../db/repositories/index.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Connection } from '../ts3/connection.js';
import type { Ts3Client, Ts3ClientLeft, Ts3ClientMoved } from '../ts3/types.js';
import { SessionTracker } from './tracker.js';

export interface WatcherDeps {
  database: AppDatabase;
  connection: Ts3Connection;
  logger: Logger;
  /** Current time in UTC seconds (injectable for tests). */
  now?: () => number;
}

/** Wires TS3 connection events to the session tracker. */
export class Watcher {
  readonly tracker: SessionTracker;
  private readonly now: () => number;
  /** When the query connection was lost; clients gone meanwhile are closed at this time. */
  private lostAt: number | undefined;
  private readonly detach: (() => void)[] = [];
  /** Clients with events while a sync is fetching lists (see `SessionTracker.sync`). */
  private touchedDuringSync: Set<number> | undefined;

  constructor(private readonly deps: WatcherDeps) {
    this.now = deps.now ?? (() => Math.floor(Date.now() / 1000));
    this.tracker = new SessionTracker(deps.database, deps.logger);
  }

  start(): void {
    const { connection } = this.deps;
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
  }

  /** Reads the channel and client lists and reconciles the tracker (initial sync, reconnect). */
  async sync(): Promise<void> {
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
      this.tracker.sync(clients, at, this.lostAt ?? at, touched);
      this.lostAt = undefined;
      logger.info({ online: this.tracker.onlineClients.length }, 'Client list synchronized');
    } catch (error) {
      logger.warn({ err: error }, 'Client list synchronization failed');
    } finally {
      if (this.touchedDuringSync === touched) this.touchedDuringSync = undefined;
    }
  }

  /** Detaches from the connection and closes all open sessions. */
  stop(): void {
    for (const off of this.detach.splice(0)) off();
    this.tracker.closeAll(this.now());
  }

  private safely(fn: () => unknown): void {
    try {
      fn();
    } catch (error) {
      this.deps.logger.error({ err: error }, 'Failed to process TS3 event');
    }
  }
}
