import { EventEmitter } from 'node:events';
import {
  QueryProtocol,
  TeamSpeak,
  type TeamSpeakChannel,
  type TeamSpeakClient,
} from 'ts3-nodejs-library';
import type { Config } from '../config/config.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Transport } from './transport.js';
import type { Ts3Channel, Ts3Client, Ts3TransportEvents } from './types.js';

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

function toTs3Channel(channel: Pick<TeamSpeakChannel, 'cid' | 'pid' | 'name'>): Ts3Channel {
  return { cid: Number(channel.cid), pid: Number(channel.pid), name: channel.name };
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
      await teamspeak.useBySid(String(this.config.serverId), this.config.botNickname);
      await teamspeak.registerEvent('server');
      await teamspeak.registerEvent('channel', '0');
    } catch (error) {
      this.teamspeak = undefined;
      teamspeak.forceQuit();
      throw error;
    }

    teamspeak.on('close', (error) => this.emit('close', error));
    teamspeak.on('clientconnect', ({ client }) => {
      this.emit('clientConnect', toTs3Client(client));
    });
    teamspeak.on('clientdisconnect', ({ event }) => {
      this.emit('clientDisconnect', { clid: Number(event.clid), reasonId: Number(event.reasonid) });
    });
    teamspeak.on('clientmoved', ({ client, channel }) => {
      this.emit('clientMoved', { clid: Number(client.clid), channelId: Number(channel.cid) });
    });
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

  private connected(): TeamSpeak {
    if (!this.teamspeak) throw new Error('Not connected');
    return this.teamspeak;
  }
}
