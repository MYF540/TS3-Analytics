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

export type Ts3ChannelKind = 'permanent' | 'semi' | 'temporary';

export interface Ts3Channel {
  cid: number;
  /** Parent channel id (0 = top level). */
  pid: number;
  name: string;
  /** Id of the channel this one is sorted after (0 = first below its parent). */
  order: number;
  /** Clients currently in the channel, query clients included. */
  totalClients: number;
  /** -1 = unlimited. */
  maxClients: number;
  kind: Ts3ChannelKind;
  hasPassword: boolean;
}

/** What a bot module may set when it creates a channel (T10.1). */
export interface Ts3ChannelCreate {
  name: string;
  /** 0 = top level. */
  parentId: number;
  kind: Ts3ChannelKind;
  /** Sort after this channel (0 = first below the parent). */
  order?: number;
  /** Temporary channels only: seconds an empty channel survives. */
  deleteDelayS?: number;
  topic?: string;
  description?: string;
  /** -1 = unlimited. */
  maxClients?: number;
  /** 0–10. */
  codecQuality?: number;
  password?: string;
  /** Voice data encrypted (the server setting may override this). */
  encrypted?: boolean;
}

/** Changes of an existing channel; only the given fields are sent. */
export interface Ts3ChannelEdit {
  name?: string;
  topic?: string;
  description?: string;
  /** -1 = unlimited. */
  maxClients?: number;
  /** Empty string removes the password. */
  password?: string;
}

export interface Ts3ChannelGroup {
  id: number;
  name: string;
  /** 0 = template, 1 = regular, 2 = query group. */
  type: number;
}

export interface Ts3GroupMember {
  dbid: number;
  uid: string;
  nickname: string;
}

/** The bot's own query client. */
export interface Ts3Self {
  clid: number;
  channelId: number;
}

/**
 * One entry of the server ban list (`banlist`). `ip` may hold a plain address or a regex; it must
 * be hashed right away and never stored or logged (AGENTS.md rule 1).
 */
export interface Ts3Ban {
  banId: number;
  ip: string | undefined;
  /** Nickname regex. */
  name: string | undefined;
  uid: string | undefined;
  lastNickname: string | undefined;
  reason: string | undefined;
  invokerName: string | undefined;
  invokerUid: string | undefined;
  /** UTC seconds. */
  createdAt: number;
  /** Seconds; 0 = permanent. */
  durationS: number;
  enforcements: number;
}

export interface Ts3ServerGroup {
  id: number;
  name: string;
  /** 0 = template, 1 = regular, 2 = query group. */
  type: number;
}

export interface Ts3ClientLeft {
  clid: number;
  /** TS3 reason id (e.g. 8 = left, 3 = timeout, 4/5 = kicked, 6 = banned). */
  reasonId: number;
}

/** `reasonid` of a move: the client switched itself, was moved or was kicked out of a channel. */
export const MOVE_REASON_SELF = 0;
export const MOVE_REASON_MOVED = 1;
export const MOVE_REASON_CHANNEL_KICK = 4;

export interface Ts3ClientMoved {
  clid: number;
  channelId: number;
  /** See `MOVE_REASON_*`. */
  reasonId: number;
  /** Who moved the client; undefined when it switched itself. */
  invokerClid: number | undefined;
}

/** A private text message sent to the bot. Never one of the bot's own messages. */
export interface Ts3TextMessage {
  clid: number;
  uid: string;
  nickname: string;
  message: string;
}

export interface Ts3ChannelCreated {
  cid: number;
  pid: number;
  name: string;
  kind: Ts3ChannelKind;
  /** Connection id of the creator (may be the bot itself or another query client). */
  invokerClid: number;
  invokerUid: string;
}

export interface Ts3ChannelDeleted {
  cid: number;
  /** 0 when the server removed an empty temporary channel. */
  invokerClid: number;
}

export interface Ts3TransportEvents {
  clientConnect: [client: Ts3Client];
  clientDisconnect: [event: Ts3ClientLeft];
  clientMoved: [event: Ts3ClientMoved];
  textMessage: [event: Ts3TextMessage];
  channelCreated: [event: Ts3ChannelCreated];
  channelDeleted: [event: Ts3ChannelDeleted];
  /** The connection is gone (network error, server shutdown, ...). */
  close: [error: Error | undefined];
}
