import type { EventEmitter } from 'node:events';
import type { Ts3Channel, Ts3Client, Ts3TransportEvents } from './types.js';

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
}

/** Creates a fresh transport for every connection attempt. */
export type Ts3TransportFactory = () => Ts3Transport;
