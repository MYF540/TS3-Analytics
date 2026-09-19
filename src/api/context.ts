import type { AppDatabase } from '../db/client.js';
import type { Logger } from '../logging/logger.js';
import type { JobStatus } from '../jobs/runner.js';
import type { ModerationCommands } from '../moderation/actions.js';
import type { ConnectionState, ConnectionStatus } from '../ts3/connection.js';
import type { LiveClient } from '../watcher/watcher.js';

/** Everything route handlers may use. Kept small so tests can build it easily. */
export interface ApiContext {
  database: AppDatabase;
  logger: Logger;
  /** Live query connection state; undefined when the watcher is not running (tests, tools). */
  ts3: { readonly state: ConnectionState } | undefined;
  /** Live view of the watcher; undefined when it is not running. */
  live: { liveClients(): LiveClient[]; clidsOf?(userId: number): number[] } | undefined;
  /** Query commands for moderation (T5.6); undefined when the watcher is not running. */
  moderation: ModerationCommands | undefined;
  /** Current time in UTC seconds. */
  now: () => number;
  /** Process start (UTC seconds), for the uptime. */
  startedAt: number;
  /** Details for the status page; undefined when the bot is not running (tests, tools). */
  bot:
    | {
        connection(): ConnectionStatus;
        jobs(): JobStatus[];
        /** Directory of the rotated log files. */
        logDir: string;
      }
    | undefined;
  /** Session settings of the web login. */
  auth: { sessionTtlS: number; cookieSecure: boolean };
}
