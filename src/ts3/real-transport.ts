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
import type { Ts3Ban, Ts3Channel, Ts3Client, Ts3ServerGroup, Ts3TransportEvents } from './types.js';

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
 * commands for every join and move, bypassing our rate-limited queue (rule 5). We replace them
 * with handlers that only use the notification payload.
 */
const REPLACED_NOTIFICATIONS = ['cliententerview', 'clientleftview', 'clientmoved'] as const;

/** Routes raw join/leave/move notifications of `teamspeak` to `target` (see above). */
export function attachNotificationHandlers(
  teamspeak: TeamSpeak,
  target: EventEmitter<Ts3TransportEvents>,
): void {
  const query = (teamspeak as unknown as { query: NodeEventEmitter }).query;
  for (const name of REPLACED_NOTIFICATIONS) query.removeAllListeners(name);
  query.on('cliententerview', (event: RawEnterView) => {
    target.emit('clientConnect', enterViewToClient(event));
  });
  query.on('clientleftview', (event: { clid: string; reasonid: string }) => {
    target.emit('clientDisconnect', { clid: Number(event.clid), reasonId: Number(event.reasonid) });
  });
  query.on('clientmoved', (event: { clid: string; ctid: string }) => {
    target.emit('clientMoved', { clid: Number(event.clid), channelId: Number(event.ctid) });
  });
}

function toTs3Channel(channel: Pick<TeamSpeakChannel, 'cid' | 'pid' | 'name'>): Ts3Channel {
  return { cid: Number(channel.cid), pid: Number(channel.pid), name: channel.name };
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
    } catch (error) {
      this.teamspeak = undefined;
      teamspeak.forceQuit();
      throw error;
    }

    teamspeak.on('close', (error) => this.emit('close', error));
    attachNotificationHandlers(teamspeak, this);
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

  private connected(): TeamSpeak {
    if (!this.teamspeak) throw new Error('Not connected');
    return this.teamspeak;
  }
}
