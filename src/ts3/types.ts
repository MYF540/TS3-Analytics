/**
 * Library-independent TS3 types. Deliberately without IP addresses: those are only fetched on
 * demand for IP processing (AGENTS.md rule 1) and never travel through these objects.
 */

export const CLIENT_TYPE_REGULAR = 0;
export const CLIENT_TYPE_QUERY = 1;

export interface Ts3Client {
  /** Connection id, only valid while the client is online. */
  clid: number;
  /** Database id on the TS3 server. */
  dbid: number;
  uid: string;
  nickname: string;
  /** 0 = regular client, 1 = ServerQuery client. */
  type: number;
  channelId: number;
  /** Milliseconds since the last client activity. */
  idleMs: number;
  away: boolean;
  inputMuted: boolean;
  outputMuted: boolean;
  /** Server group ids. */
  serverGroups: number[];
  platform: string;
  version: string;
  /** ISO country code reported by the server, if any. */
  country: string | undefined;
}

export interface Ts3Channel {
  cid: number;
  /** Parent channel id (0 = top level). */
  pid: number;
  name: string;
}

export interface Ts3ClientLeft {
  clid: number;
  /** TS3 reason id (e.g. 8 = left, 3 = timeout, 4/5 = kicked, 6 = banned). */
  reasonId: number;
}

export interface Ts3ClientMoved {
  clid: number;
  channelId: number;
}

export interface Ts3TransportEvents {
  clientConnect: [client: Ts3Client];
  clientDisconnect: [event: Ts3ClientLeft];
  clientMoved: [event: Ts3ClientMoved];
  /** The connection is gone (network error, server shutdown, ...). */
  close: [error: Error | undefined];
}
