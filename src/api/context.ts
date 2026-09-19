import type { AppDatabase } from '../db/client.js';
import type { Logger } from '../logging/logger.js';
import type { ConnectionState } from '../ts3/connection.js';
import type { LiveClient } from '../watcher/watcher.js';

/** Everything route handlers may use. Kept small so tests can build it easily. */
export interface ApiContext {
  database: AppDatabase;
  logger: Logger;
  /** Live query connection state; undefined when the watcher is not running (tests, tools). */
  ts3: { readonly state: ConnectionState } | undefined;
  /** Live view of the watcher; undefined when it is not running. */
  live: { liveClients(): LiveClient[] } | undefined;
  /** Current time in UTC seconds. */
  now: () => number;
  /** Process start (UTC seconds), for the uptime. */
  startedAt: number;
}
