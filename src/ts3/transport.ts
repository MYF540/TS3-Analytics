import type { EventEmitter } from 'node:events';
import type { Ts3Ban, Ts3Channel, Ts3Client, Ts3ServerGroup, Ts3TransportEvents } from './types.js';

/**
 * One physical ServerQuery connection. It does not reconnect or rate-limit by itself; that is
 * the job of `Ts3Connection` and `CommandQueue`. Implementations: `RealTs3Transport` (SSH query)
 * and `FakeTs3Transport` (tests, AGENTS.md rule 9).
 */
export interface Ts3Transport extends EventEmitter<Ts3TransportEvents> {
  /** Connects, logs in, selects the virtual server, sets the nickname and registers events. */
  connect(): Promise<void>;
  /** Closes the connection. Does not emit `close`. */
  disconnect(): Promise<void>;
  clientList(): Promise<Ts3Client[]>;
  channelList(): Promise<Ts3Channel[]>;
  /** Cheap command used as keepalive and health check. */
  ping(): Promise<void>;
  /**
   * The client's IP address (`clientinfo`). Callers must hash it right away and never store or
   * log it (AGENTS.md rule 1).
   */
  clientIp(clid: number): Promise<string | undefined>;
  /** IP addresses of all online clients in one command (`clientlist -ip`). Same rules apply. */
  clientIps(): Promise<Map<number, string>>;
  /** The whole ban list (empty when there are no bans). Same rules apply to `ip`. */
  banList(): Promise<Ts3Ban[]>;

  serverGroups(): Promise<Ts3ServerGroup[]>;
  /**
   * The newest lines of the virtual server log (`logview`, at most 100). Lines can contain IP
   * addresses: callers only parse what they need and never store or log the raw text.
   */
  logLines(lines: number): Promise<string[]>;

  /** Adds a client (by database id) to a server group (rank job, T6.3). */
  addToServerGroup(dbid: number, groupId: number): Promise<void>;
  removeFromServerGroup(dbid: number, groupId: number): Promise<void>;

  // Moderation (T5.6). Callers check permissions, the global switch and write the audit log.
  /** Kicks from the server or back to the default channel. `reason` max. 40 characters. */
  kick(clid: number, from: 'server' | 'channel', reason: string): Promise<void>;
  poke(clid: number, message: string): Promise<void>;
  /** Private text message to the client. */
  sendMessage(clid: number, message: string): Promise<void>;
  move(clid: number, channelId: number): Promise<void>;
  /** Adds a ban rule for this UID (`banadd uid=`). `durationS` 0 = permanent. */
  banUid(uid: string, durationS: number, reason: string): Promise<void>;
  /** `banclient`: bans UID and current IP of an online client and disconnects it. */
  banClient(clid: number, durationS: number, reason: string): Promise<void>;
}

/** Creates a fresh transport for every connection attempt. */
export type Ts3TransportFactory = () => Ts3Transport;
