import type { EventEmitter as NodeEventEmitter } from 'node:events';
import { EventEmitter } from 'node:events';
import {
  QueryProtocol,
  ReasonIdentifier,
  ResponseError,
  TeamSpeak,
  TextMessageTargetMode,
  type TeamSpeakChannel,
  type TeamSpeakClient,
} from 'ts3-nodejs-library';
import type { Config } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import { useWithFreeNickname } from './nickname.js';
import type { Ts3Transport } from './transport.js';
import type {
  Ts3Ban,
  Ts3Channel,
  Ts3ChannelCreate,
  Ts3ChannelEdit,
  Ts3ChannelGroup,
  Ts3ChannelKind,
  Ts3Client,
  Ts3GroupMember,
  Ts3Self,
  Ts3ServerGroup,
  Ts3TransportEvents,
} from './types.js';

type ClientLike = Pick<
  TeamSpeakClient,
  | 'clid'
  | 'databaseId'
  | 'uniqueIdentifier'
  | 'nickname'
  | 'type'
  | 'cid'
  | 'idleTime'
  | 'away'
  | 'inputMuted'
  | 'outputMuted'
  | 'servergroups'
  | 'platform'
  | 'version'
  | 'country'
>;

/** Maps a library client to our type. Copies no IP address (AGENTS.md rule 1). */
export function toTs3Client(client: ClientLike): Ts3Client {
  return {
    clid: Number(client.clid),
    dbid: Number(client.databaseId),
    uid: client.uniqueIdentifier,
    nickname: client.nickname,
    type: client.type,
    channelId: Number(client.cid),
    idleMs: client.idleTime,
    away: Boolean(client.away),
    inputMuted: client.inputMuted,
    outputMuted: client.outputMuted,
    serverGroups: client.servergroups.map(Number),
    platform: client.platform,
    version: client.version,
    country: client.country ?? undefined,
  };
}

/** Raw `notifycliententerview` as parsed by the library (camelCase keys). */
export interface RawEnterView {
  clid: string;
  ctid: string;
  clientDatabaseId: string;
  clientUniqueIdentifier: string;
  clientNickname: string;
  clientType: number;
  clientAway?: boolean;
  clientInputMuted?: boolean;
  clientOutputMuted?: boolean;
  clientServergroups?: string[];
  clientPlatform?: string;
  clientVersion?: string;
  clientCountry?: string;
}

/** Builds a client from the join notification itself, without an extra `clientlist`. */
export function enterViewToClient(event: RawEnterView): Ts3Client {
  return {
    clid: Number(event.clid),
    dbid: Number(event.clientDatabaseId),
    uid: event.clientUniqueIdentifier,
    nickname: event.clientNickname,
    type: event.clientType,
    channelId: Number(event.ctid),
    idleMs: 0,
    away: event.clientAway ?? false,
    inputMuted: event.clientInputMuted ?? false,
    outputMuted: event.clientOutputMuted ?? false,
    serverGroups: (event.clientServergroups ?? []).map(Number),
    platform: event.clientPlatform ?? '',
    version: event.clientVersion ?? '',
    country: event.clientCountry || undefined,
  };
}

/**
 * The library's own handlers for these notifications run extra `clientlist`/`channellist`
 * commands for every join, move, message and channel change, bypassing our rate-limited queue
 * (rule 5). We replace them with handlers that only use the notification payload; the ones we
 * have no use for are dropped altogether.
 */
const REPLACED_NOTIFICATIONS = [
  'cliententerview',
  'clientleftview',
  'clientmoved',
  'textmessage',
  'channelcreated',
  'channeldeleted',
  'channeledited',
  'channelmoved',
  'serveredited',
  'tokenused',
] as const;

/** Raw `notifyclientmoved`; `invokerid` is missing when the client switched itself. */
export interface RawClientMoved {
  clid: string;
  ctid: string;
  reasonid?: string;
  invokerid?: string;
}

export interface RawTextMessage {
  targetmode: number | string;
  msg: string;
  invokerid: string;
  invokername: string;
  invokeruid: string;
}

export interface RawChannelCreated {
  cid: string;
  cpid: string;
  channelName: string;
  channelFlagPermanent?: unknown;
  channelFlagSemiPermanent?: unknown;
  invokerid: string;
  invokeruid?: string;
}

/** `targetmode` of a private message (1 = client, 2 = channel, 3 = server). */
const TARGET_MODE_CLIENT = 1;

const flag = (value: unknown): boolean => value === true || value === 1 || value === '1';

function channelKind(permanent: unknown, semiPermanent: unknown): Ts3ChannelKind {
  if (flag(permanent)) return 'permanent';
  return flag(semiPermanent) ? 'semi' : 'temporary';
}

/**
 * Routes raw notifications of `teamspeak` to `target` (see above). `selfClid` is the bot's own
 * connection id: the server echoes the bot's private messages back, those are dropped.
 */
export function attachNotificationHandlers(
  teamspeak: TeamSpeak,
  target: EventEmitter<Ts3TransportEvents>,
  selfClid?: number,
): void {
  const query = (teamspeak as unknown as { query: NodeEventEmitter }).query;
  for (const name of REPLACED_NOTIFICATIONS) query.removeAllListeners(name);
  query.on('cliententerview', (event: RawEnterView) => {
    target.emit('clientConnect', enterViewToClient(event));
  });
  query.on('clientleftview', (event: { clid: string; reasonid: string }) => {
    target.emit('clientDisconnect', { clid: Number(event.clid), reasonId: Number(event.reasonid) });
  });
  query.on('clientmoved', (event: RawClientMoved) => {
    target.emit('clientMoved', {
      clid: Number(event.clid),
      channelId: Number(event.ctid),
      reasonId: Number(event.reasonid ?? 0),
      invokerClid: event.invokerid === undefined ? undefined : Number(event.invokerid),
    });
  });
  query.on('textmessage', (event: RawTextMessage) => {
    const clid = Number(event.invokerid);
    if (Number(event.targetmode) !== TARGET_MODE_CLIENT || clid === selfClid) {
      return;
    }
    target.emit('textMessage', {
      clid,
      uid: event.invokeruid,
      nickname: event.invokername,
      message: event.msg,
    });
  });
  query.on('channelcreated', (event: RawChannelCreated) => {
    target.emit('channelCreated', {
      cid: Number(event.cid),
      pid: Number(event.cpid),
      name: event.channelName,
      kind: channelKind(event.channelFlagPermanent, event.channelFlagSemiPermanent),
      invokerClid: Number(event.invokerid),
      invokerUid: event.invokeruid ?? '',
    });
  });
  query.on('channeldeleted', (event: { cid: string; invokerid?: string }) => {
    target.emit('channelDeleted', {
      cid: Number(event.cid),
      invokerClid: Number(event.invokerid ?? 0),
    });
  });
}

type ChannelLike = Pick<
  TeamSpeakChannel,
  | 'cid'
  | 'pid'
  | 'name'
  | 'order'
  | 'totalClients'
  | 'maxclients'
  | 'flagPermanent'
  | 'flagSemiPermanent'
  | 'flagPassword'
>;

export function toTs3Channel(channel: ChannelLike): Ts3Channel {
  return {
    cid: Number(channel.cid),
    pid: Number(channel.pid),
    name: channel.name,
    order: count(channel.order),
    totalClients: count(channel.totalClients),
    maxClients: Number.isFinite(channel.maxclients) ? channel.maxclients : -1,
    kind: channelKind(channel.flagPermanent, channel.flagSemiPermanent),
    hasPassword: flag(channel.flagPassword),
  };
}

type QueryProps = Record<string, string | number | boolean>;

/** `-1` (unlimited) needs its own flag; a number alone would be ignored by the server. */
function maxClientsProps(maxClients: number | undefined): QueryProps {
  if (maxClients === undefined) return {};
  return maxClients < 0
    ? { channelFlagMaxclientsUnlimited: true }
    : { channelFlagMaxclientsUnlimited: false, channelMaxclients: maxClients };
}

/** Parameters of `channelcreate` for our description of a new channel. */
export function channelCreateProps(channel: Ts3ChannelCreate): QueryProps {
  return {
    channelName: channel.name,
    cpid: channel.parentId,
    ...(channel.kind === 'permanent' ? { channelFlagPermanent: true } : {}),
    ...(channel.kind === 'semi' ? { channelFlagSemiPermanent: true } : {}),
    ...(channel.order === undefined ? {} : { channelOrder: channel.order }),
    ...(channel.kind === 'temporary' && channel.deleteDelayS !== undefined
      ? { channelDeleteDelay: channel.deleteDelayS }
      : {}),
    ...(channel.topic === undefined ? {} : { channelTopic: channel.topic }),
    ...(channel.description === undefined ? {} : { channelDescription: channel.description }),
    ...maxClientsProps(channel.maxClients),
    ...(channel.codecQuality === undefined ? {} : { channelCodecQuality: channel.codecQuality }),
    ...(channel.password ? { channelPassword: channel.password } : {}),
    ...(channel.encrypted === undefined ? {} : { channelCodecIsUnencrypted: !channel.encrypted }),
  };
}

/** Parameters of `channeledit`; fields that were not given are not sent. */
export function channelEditProps(changes: Ts3ChannelEdit): QueryProps {
  return {
    ...(changes.name === undefined ? {} : { channelName: changes.name }),
    ...(changes.topic === undefined ? {} : { channelTopic: changes.topic }),
    ...(changes.description === undefined ? {} : { channelDescription: changes.description }),
    ...maxClientsProps(changes.maxClients),
    ...(changes.password === undefined ? {} : { channelPassword: changes.password }),
  };
}

/** The server answers an empty list with error 1281 instead of no rows. */
async function emptyOn1281<T>(run: () => Promise<T | T[]>): Promise<T[]> {
  try {
    const result = await run();
    return Array.isArray(result) ? result : [result];
  } catch (error) {
    if (error instanceof ResponseError && error.id === '1281') return [];
    throw error;
  }
}

const BAN_PAGE_SIZE = 1000;
const BAN_PAGES_MAX = 50;

/** Reads `banlist` page by page. An empty list answers with error 1281 ("empty result set"). */
export async function fetchAllBans(
  fetchPage: (start: number, count: number) => Promise<RawBan[]>,
): Promise<Ts3Ban[]> {
  const result: Ts3Ban[] = [];
  for (let page = 0; page < BAN_PAGES_MAX; page++) {
    let rows: RawBan[];
    try {
      rows = await fetchPage(page * BAN_PAGE_SIZE, BAN_PAGE_SIZE);
    } catch (error) {
      if (error instanceof ResponseError && error.id === '1281') break;
      throw error;
    }
    result.push(...rows.map(toTs3Ban));
    if (rows.length < BAN_PAGE_SIZE) break;
  }
  return result;
}

const count = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const optional = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined;

type RawBan = Awaited<ReturnType<TeamSpeak['banList']>>[number];

export function toTs3Ban(row: RawBan): Ts3Ban {
  return {
    banId: Number(row.banid),
    ip: optional(row.ip),
    name: optional(row.name),
    uid: optional(row.uid),
    lastNickname: optional(row.lastnickname),
    reason: optional(row.reason),
    invokerName: optional(row.invokername),
    invokerUid: optional(row.invokeruid),
    createdAt: count(row.created),
    durationS: count(row.duration),
    enforcements: count(row.enforcements),
  };
}

/** ServerQuery over SSH via ts3-nodejs-library. */
export class RealTs3Transport extends EventEmitter<Ts3TransportEvents> implements Ts3Transport {
  private teamspeak: TeamSpeak | undefined;
  private selfClid: number | undefined;

  constructor(
    private readonly config: Config['ts3'],
    private readonly logger: Logger,
  ) {
    super();
  }

  async connect(): Promise<void> {
    const teamspeak = new TeamSpeak({
      host: this.config.host,
      protocol: QueryProtocol.SSH,
      queryport: this.config.queryPort,
      username: this.config.queryUser,
      password: this.config.queryPassword,
      // Our own keepalive (Ts3Connection) goes through the rate-limited queue.
      keepAlive: false,
      // Query clients are filtered by Ts3Connection as well; this also hides them in events.
      ignoreQueries: true,
      readyTimeout: 10_000,
      autoConnect: false,
    });
    // Connection errors are also reported (and logged) by Ts3Connection; keep these at debug.
    teamspeak.on('error', (error) => {
      this.logger.debug({ err: error }, 'TS3 query error');
    });
    teamspeak.on('flooding', (error) => {
      this.logger.error({ err: error }, 'TS3 anti-flood triggered – check the query IP allowlist');
    });

    await teamspeak.connect();
    this.teamspeak = teamspeak;
    try {
      const nickname = await useWithFreeNickname(this.config.botNickname, (nick) =>
        teamspeak.useBySid(String(this.config.serverId), nick),
      );
      if (nickname !== this.config.botNickname) {
        this.logger.warn({ nickname }, 'Bot nickname in use, connected with an alternative');
      }
      await teamspeak.registerEvent('server');
      await teamspeak.registerEvent('channel', '0');
      this.selfClid = Number((await teamspeak.whoami()).clientId);
      // Private messages to the bot (rule confirmation, T10.8). Time tracking does not depend
      // on them, so a refusal must not keep the bot from connecting.
      await teamspeak.registerEvent('textprivate').catch((error: unknown) => {
        this.logger.warn({ err: error }, 'Private messages to the bot are not available');
      });
    } catch (error) {
      this.teamspeak = undefined;
      teamspeak.forceQuit();
      throw error;
    }

    teamspeak.on('close', (error) => this.emit('close', error));
    attachNotificationHandlers(teamspeak, this, this.selfClid);
  }

  async disconnect(): Promise<void> {
    const teamspeak = this.teamspeak;
    this.teamspeak = undefined;
    if (!teamspeak) return;
    teamspeak.removeAllListeners('close');
    try {
      await teamspeak.quit();
    } catch {
      teamspeak.forceQuit();
    }
  }

  async clientList(): Promise<Ts3Client[]> {
    const clients = await this.connected().clientList();
    return clients.map(toTs3Client);
  }

  async channelList(): Promise<Ts3Channel[]> {
    const channels = await this.connected().channelList();
    return channels.map(toTs3Channel);
  }

  async ping(): Promise<void> {
    await this.connected().whoami();
  }

  async clientIps(): Promise<Map<number, string>> {
    const rows = await this.connected().execute<{ clid: string; connectionClientIp?: string }[]>(
      'clientlist',
      ['-ip'],
    );
    const result = new Map<number, string>();
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (row.connectionClientIp) result.set(Number(row.clid), row.connectionClientIp);
    }
    return result;
  }

  async banList(): Promise<Ts3Ban[]> {
    const query = this.connected();
    return fetchAllBans((start, count) => query.banList(start, count));
  }

  async serverGroups(): Promise<Ts3ServerGroup[]> {
    const groups = await this.connected().serverGroupList();
    return groups.map((g) => ({ id: Number(g.sgid), name: g.name, type: g.type }));
  }

  async logLines(lines: number): Promise<string[]> {
    // Called directly: the library's logView() always sends begin_pos=0.
    const rows = await this.connected().execute<{ l?: string }[]>('logview', {
      lines: Math.min(100, Math.max(1, lines)),
      reverse: 1,
      instance: 0,
    });
    return (Array.isArray(rows) ? rows : [rows]).flatMap((r) => (r.l ? [r.l] : []));
  }

  async addToServerGroup(dbid: number, groupId: number): Promise<void> {
    await this.connected().serverGroupAddClient(String(dbid), String(groupId));
  }

  async removeFromServerGroup(dbid: number, groupId: number): Promise<void> {
    await this.connected().serverGroupDelClient(String(dbid), String(groupId));
  }

  async kick(clid: number, from: 'server' | 'channel', reason: string): Promise<void> {
    await this.connected().clientKick(
      String(clid),
      from === 'server' ? ReasonIdentifier.KICK_SERVER : ReasonIdentifier.KICK_CHANNEL,
      reason,
    );
  }

  async poke(clid: number, message: string): Promise<void> {
    await this.connected().clientPoke(String(clid), message);
  }

  async sendMessage(clid: number, message: string): Promise<void> {
    await this.connected().sendTextMessage(String(clid), TextMessageTargetMode.CLIENT, message);
  }

  async move(clid: number, channelId: number): Promise<void> {
    await this.connected().clientMove(String(clid), String(channelId));
  }

  async banUid(uid: string, durationS: number, reason: string): Promise<void> {
    await this.connected().ban({
      // The ServerQuery manual documents uid={clientUID} (not a regex, unlike ip/name).
      uid,
      banreason: reason,
      ...(durationS > 0 ? { time: durationS } : {}),
    });
  }

  async banClient(clid: number, durationS: number, reason: string): Promise<void> {
    await this.connected().banClient({
      clid: String(clid),
      banreason: reason,
      ...(durationS > 0 ? { time: durationS } : {}),
    });
  }

  async clientIp(clid: number): Promise<string | undefined> {
    const [info] = await this.connected().clientInfo(String(clid));
    return info?.connectionClientIp || undefined;
  }

  async self(): Promise<Ts3Self> {
    const me = await this.connected().whoami();
    return { clid: Number(me.clientId), channelId: Number(me.clientChannelId) };
  }

  // The library's own channel helpers run an extra `channellist` each; `execute` does not.
  async channelCreate(channel: Ts3ChannelCreate): Promise<number> {
    const rows = await this.connected().execute<{ cid: string } | { cid: string }[]>(
      'channelcreate',
      channelCreateProps(channel),
    );
    const cid = Number((Array.isArray(rows) ? rows[0] : rows)?.cid);
    if (!Number.isInteger(cid) || cid <= 0) throw new Error('channelcreate returned no channel id');
    return cid;
  }

  async channelEdit(cid: number, changes: Ts3ChannelEdit): Promise<void> {
    const props = channelEditProps(changes);
    if (Object.keys(props).length === 0) return;
    await this.connected().execute('channeledit', { cid, ...props });
  }

  async channelDelete(cid: number, force: boolean): Promise<void> {
    await this.connected().execute('channeldelete', { cid, force });
  }

  async channelSetPermission(cid: number, permission: string, value: number): Promise<void> {
    await this.connected().execute('channeladdperm', {
      cid,
      permsid: permission,
      permvalue: value,
    });
  }

  async channelGroups(): Promise<Ts3ChannelGroup[]> {
    const query = this.connected();
    const rows = await emptyOn1281(() =>
      query.execute<{ cgid: string; name: string; type: number | string }[]>('channelgrouplist'),
    );
    return rows.map((g) => ({ id: Number(g.cgid), name: g.name, type: Number(g.type) }));
  }

  async setChannelGroup(dbid: number, cid: number, channelGroupId: number): Promise<void> {
    await this.connected().execute('setclientchannelgroup', {
      cgid: channelGroupId,
      cid,
      cldbid: dbid,
    });
  }

  async serverGroupMembers(groupId: number): Promise<Ts3GroupMember[]> {
    const query = this.connected();
    const rows = await emptyOn1281(() =>
      query.execute<{ cldbid: string; clientNickname: string; clientUniqueIdentifier: string }[]>(
        'servergroupclientlist',
        { sgid: groupId },
        ['-names'],
      ),
    );
    return rows.map((m) => ({
      dbid: Number(m.cldbid),
      uid: m.clientUniqueIdentifier,
      nickname: m.clientNickname,
    }));
  }

  private connected(): TeamSpeak {
    if (!this.teamspeak) throw new Error('Not connected');
    return this.teamspeak;
  }
}
