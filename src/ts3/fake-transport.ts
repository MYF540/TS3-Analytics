import { EventEmitter } from 'node:events';
import type { Ts3Transport } from './transport.js';
import {
  CLIENT_TYPE_REGULAR,
  type Ts3Ban,
  type Ts3Channel,
  type Ts3Client,
  type Ts3TransportEvents,
} from './types.js';

/**
 * Simulated TeamSpeak server shared by all fake transports (a new transport is created per
 * connection attempt, like with the real server). Tests drive it with `join`, `leave`, `move`,
 * `update` and `dropConnection`. Never talks to a real server (AGENTS.md rule 9).
 */
export class FakeTs3Server {
  readonly clients = new Map<number, Ts3Client>();
  /** IP addresses per clid (kept apart from `Ts3Client`, like on the real server). */
  readonly ips = new Map<number, string>();
  readonly channels = new Map<number, Ts3Channel>([[1, { cid: 1, pid: 0, name: 'Lobby' }]]);
  /** Every executed command, in order, with the time it started. */
  readonly commandLog: { command: string; at: number }[] = [];
  /** Ban list as returned by `banlist`. */
  bans: Ts3Ban[] = [];
  /** Moderation commands received (T5.6), for assertions. */
  readonly moderation: {
    command: string;
    clid?: number;
    uid?: string;
    text?: string;
    value?: number;
  }[] = [];
  private nextBanId = 1000;
  /** Number of upcoming connection attempts that should fail. */
  failConnects = 0;
  /** When set, `ping` fails (simulates a dead connection that did not emit `close`). */
  failPing = false;
  connectAttempts = 0;
  /** Called after a command took its snapshot but before it answers (to simulate races). */
  afterSnapshot: ((command: string) => void) | undefined;
  private active: FakeTs3Transport | undefined;
  private nextClid = 1;

  constructor(private readonly now: () => number = () => Date.now()) {}

  createTransport = (): FakeTs3Transport => new FakeTs3Transport(this);

  get connected(): boolean {
    return this.active !== undefined;
  }

  /** @internal */
  attach(transport: FakeTs3Transport): void {
    this.connectAttempts++;
    if (this.failConnects > 0) {
      this.failConnects--;
      throw new Error('connection refused (fake)');
    }
    this.active = transport;
  }

  /** @internal */
  detach(transport: FakeTs3Transport): void {
    if (this.active === transport) this.active = undefined;
  }

  /** @internal */
  log(command: string): void {
    this.commandLog.push({ command, at: this.now() });
  }

  addChannel(cid: number, name: string, pid = 0): void {
    this.channels.set(cid, { cid, pid, name });
  }

  /** A client connects; returns its clid. */
  join(client: Partial<Ts3Client> & Pick<Ts3Client, 'uid' | 'nickname'>, ip?: string): number {
    const clid = client.clid ?? this.nextClid++;
    if (ip !== undefined) this.ips.set(clid, ip);
    const full: Ts3Client = {
      clid,
      dbid: client.dbid ?? clid + 100,
      type: CLIENT_TYPE_REGULAR,
      channelId: 1,
      idleMs: 0,
      away: false,
      inputMuted: false,
      outputMuted: false,
      serverGroups: [8],
      platform: 'Windows',
      version: '3.6.2 [Build: 1690193193]',
      country: 'DE',
      ...client,
    };
    this.clients.set(clid, full);
    this.active?.emit('clientConnect', { ...full });
    return clid;
  }

  leave(clid: number, reasonId = 8): void {
    if (!this.clients.delete(clid)) return;
    this.ips.delete(clid);
    this.active?.emit('clientDisconnect', { clid, reasonId });
  }

  move(clid: number, channelId: number): void {
    const client = this.clients.get(clid);
    if (!client) return;
    client.channelId = channelId;
    this.active?.emit('clientMoved', { clid, channelId });
  }

  /** Changes client properties without an event (e.g. nickname, idle time), like the real server. */
  update(clid: number, changes: Partial<Ts3Client>): void {
    const client = this.clients.get(clid);
    if (client) Object.assign(client, changes);
  }

  /** Adds a ban rule, like `banadd` on the real server. */
  addBan(ban: { uid: string; reason: string; durationS: number }): void {
    this.bans.push({
      banId: this.nextBanId++,
      ip: undefined,
      name: undefined,
      uid: ban.uid,
      lastNickname: undefined,
      reason: ban.reason,
      invokerName: 'TS3 Analytics',
      invokerUid: undefined,
      createdAt: Math.floor(this.now() / 1000),
      durationS: ban.durationS,
      enforcements: 0,
    });
  }

  /** Simulates a network failure or server restart. */
  dropConnection(error = new Error('connection lost (fake)')): void {
    const transport = this.active;
    this.active = undefined;
    transport?.emit('close', error);
  }
}

export class FakeTs3Transport extends EventEmitter<Ts3TransportEvents> implements Ts3Transport {
  private open = false;

  constructor(private readonly server: FakeTs3Server) {
    super();
  }

  connect(): Promise<void> {
    this.server.log('connect');
    this.server.attach(this);
    this.open = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.open = false;
    this.server.detach(this);
    return Promise.resolve();
  }

  clientList(): Promise<Ts3Client[]> {
    this.assertOpen('clientlist');
    const snapshot = [...this.server.clients.values()].map((c) => ({ ...c }));
    this.server.afterSnapshot?.('clientlist');
    return Promise.resolve(snapshot);
  }

  channelList(): Promise<Ts3Channel[]> {
    this.assertOpen('channellist');
    return Promise.resolve([...this.server.channels.values()].map((c) => ({ ...c })));
  }

  kick(clid: number, from: 'server' | 'channel', reason: string): Promise<void> {
    this.assertOpen(`clientkick ${from}`);
    this.requireClient(clid);
    this.server.moderation.push({ command: `kick.${from}`, clid, text: reason });
    if (from === 'server') this.server.leave(clid, 5);
    else this.server.move(clid, 1);
    return Promise.resolve();
  }

  poke(clid: number, message: string): Promise<void> {
    this.assertOpen('clientpoke');
    this.requireClient(clid);
    this.server.moderation.push({ command: 'poke', clid, text: message });
    return Promise.resolve();
  }

  sendMessage(clid: number, message: string): Promise<void> {
    this.assertOpen('sendtextmessage');
    this.requireClient(clid);
    this.server.moderation.push({ command: 'message', clid, text: message });
    return Promise.resolve();
  }

  move(clid: number, channelId: number): Promise<void> {
    this.assertOpen('clientmove');
    this.requireClient(clid);
    if (!this.server.channels.has(channelId)) throw new Error('invalid channelID (fake)');
    this.server.moderation.push({ command: 'move', clid, value: channelId });
    this.server.move(clid, channelId);
    return Promise.resolve();
  }

  banUid(uid: string, durationS: number, reason: string): Promise<void> {
    this.assertOpen('banadd');
    this.server.moderation.push({ command: 'ban.uid', uid, text: reason, value: durationS });
    this.server.addBan({ uid, reason, durationS });
    return Promise.resolve();
  }

  banClient(clid: number, durationS: number, reason: string): Promise<void> {
    this.assertOpen('banclient');
    const client = this.requireClient(clid);
    this.server.moderation.push({ command: 'ban.client', clid, text: reason, value: durationS });
    this.server.addBan({ uid: client.uid, reason, durationS });
    this.server.leave(clid, 6);
    return Promise.resolve();
  }

  private requireClient(clid: number): Ts3Client {
    const client = this.server.clients.get(clid);
    if (!client) throw new Error('invalid clientID (fake)');
    return client;
  }

  banList(): Promise<Ts3Ban[]> {
    this.assertOpen('banlist');
    return Promise.resolve(this.server.bans.map((b) => ({ ...b })));
  }

  clientIps(): Promise<Map<number, string>> {
    this.assertOpen('clientlist -ip');
    const result = new Map<number, string>();
    for (const clid of this.server.clients.keys()) {
      const ip = this.server.ips.get(clid);
      if (ip !== undefined) result.set(clid, ip);
    }
    return Promise.resolve(result);
  }

  clientIp(clid: number): Promise<string | undefined> {
    this.assertOpen('clientinfo');
    return Promise.resolve(this.server.clients.has(clid) ? this.server.ips.get(clid) : undefined);
  }

  ping(): Promise<void> {
    this.assertOpen('whoami');
    if (this.server.failPing) return Promise.reject(new Error('ping timeout (fake)'));
    return Promise.resolve();
  }

  private assertOpen(command: string): void {
    this.server.log(command);
    if (!this.open || !this.server.connected) throw new Error('not connected (fake)');
  }
}
