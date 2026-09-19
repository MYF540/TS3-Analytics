import { EventEmitter } from 'node:events';
import { scrubIps, type Logger } from '../logging/logger.js';
import { CommandQueue, systemClock, type Clock } from './command-queue.js';
import type { Ts3Transport, Ts3TransportFactory } from './transport.js';
import {
  CLIENT_TYPE_QUERY,
  type Ts3Ban,
  type Ts3ServerGroup,
  type Ts3Channel,
  type Ts3Client,
  type Ts3ClientLeft,
  type Ts3ClientMoved,
} from './types.js';

export interface ConnectionOptions {
  /** Maximum query commands per second (AGENTS.md rule 5). */
  commandsPerSecond: number;
  /** First reconnect delay; doubles on every failed attempt. */
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  /** Interval of the keepalive ping; a failed ping forces a reconnect. */
  keepAliveMs?: number;
  /** Random extra delay (0..1 × delay) so restarts do not hammer the server in lockstep. */
  jitter?: number;
}

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'waiting' | 'stopped';

/** Snapshot for the status page; times in UTC seconds. */
export interface ConnectionStatus {
  state: ConnectionState;
  /** When the current state began. */
  since: number;
  /** Failed connection attempts in a row (0 while connected). */
  failedAttempts: number;
  lastConnectedAt: number | undefined;
  /** Last connection error or close reason, already free of IP addresses. */
  lastError: { at: number; message: string } | undefined;
  /** Commands waiting in the rate-limited queue. */
  queuedCommands: number;
}

export interface Ts3ConnectionEvents {
  connected: [];
  disconnected: [error: Error | undefined];
  stateChange: [state: ConnectionState];
  clientConnect: [client: Ts3Client];
  clientDisconnect: [event: Ts3ClientLeft];
  clientMoved: [event: Ts3ClientMoved];
}

export class NotConnectedError extends Error {
  constructor() {
    super('Not connected to the TeamSpeak server');
    this.name = 'NotConnectedError';
  }
}

export interface ConnectionDeps {
  logger: Logger;
  clock?: Clock;
  random?: () => number;
  setInterval?: (fn: () => void, ms: number) => unknown;
  clearInterval?: (handle: unknown) => void;
}

/**
 * Keeps one ServerQuery connection alive: reconnects with exponential backoff, sends keepalives,
 * funnels every command through the central `CommandQueue` and hides query clients (rule 4).
 */
export class Ts3Connection extends EventEmitter<Ts3ConnectionEvents> {
  readonly queue: CommandQueue;
  private transport: Ts3Transport | undefined;
  private currentState: ConnectionState = 'idle';
  private stateSince: number;
  private lastConnectedAt: number | undefined;
  private lastError: { at: number; message: string } | undefined;
  private attempt = 0;
  private keepAliveHandle: unknown;
  private readonly clock: Clock;
  private readonly random: () => number;
  private readonly initialBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly keepAliveMs: number;
  private readonly jitter: number;
  private loop: Promise<void> | undefined;
  private wake: (() => void) | undefined;
  /** Resolves the wait of `run()` for the current connection to end. */
  private connectionEnded: (() => void) | undefined;

  constructor(
    private readonly factory: Ts3TransportFactory,
    options: ConnectionOptions,
    private readonly deps: ConnectionDeps,
  ) {
    super();
    this.clock = deps.clock ?? systemClock;
    this.random = deps.random ?? Math.random;
    this.queue = new CommandQueue(options.commandsPerSecond, this.clock);
    this.initialBackoffMs = options.initialBackoffMs ?? 1000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60_000;
    this.keepAliveMs = options.keepAliveMs ?? 60_000;
    this.jitter = options.jitter ?? 0.2;
    this.stateSince = this.nowS();
  }

  status(): ConnectionStatus {
    return {
      state: this.currentState,
      since: this.stateSince,
      failedAttempts: this.currentState === 'connected' ? 0 : this.attempt,
      lastConnectedAt: this.lastConnectedAt,
      lastError: this.lastError,
      queuedCommands: this.queue.pending,
    };
  }

  private nowS(): number {
    return Math.floor(this.clock.now() / 1000);
  }

  private rememberError(error: unknown): void {
    if (error === undefined) return;
    const message =
      error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
    this.lastError = { at: this.nowS(), message: scrubIps(message).slice(0, 300) };
  }

  get state(): ConnectionState {
    return this.currentState;
  }

  get isConnected(): boolean {
    return this.currentState === 'connected';
  }

  /** Starts connecting in the background; reconnects until `stop()` is called. */
  start(): void {
    if (this.loop) return;
    this.loop = this.run();
  }

  /** Stops reconnecting and closes the connection. */
  async stop(): Promise<void> {
    this.setState('stopped');
    this.wake?.();
    this.stopKeepAlive();
    this.queue.clear();
    const transport = this.transport;
    this.transport = undefined;
    this.connectionEnded?.();
    if (transport) {
      transport.removeAllListeners();
      await transport.disconnect().catch(() => undefined);
    }
    await this.loop;
    this.loop = undefined;
  }

  /** Online clients without ServerQuery clients (including the bot itself). */
  async clientList(): Promise<Ts3Client[]> {
    const clients = await this.command((t) => t.clientList());
    return clients.filter((c) => c.type !== CLIENT_TYPE_QUERY);
  }

  async banList(): Promise<Ts3Ban[]> {
    return this.command((t) => t.banList());
  }

  serverGroups(): Promise<Ts3ServerGroup[]> {
    return this.command((t) => t.serverGroups());
  }

  logLines(lines: number): Promise<string[]> {
    return this.command((t) => t.logLines(lines));
  }

  kick(clid: number, from: 'server' | 'channel', reason: string): Promise<void> {
    return this.command((t) => t.kick(clid, from, reason));
  }

  poke(clid: number, message: string): Promise<void> {
    return this.command((t) => t.poke(clid, message));
  }

  sendMessage(clid: number, message: string): Promise<void> {
    return this.command((t) => t.sendMessage(clid, message));
  }

  move(clid: number, channelId: number): Promise<void> {
    return this.command((t) => t.move(clid, channelId));
  }

  banUid(uid: string, durationS: number, reason: string): Promise<void> {
    return this.command((t) => t.banUid(uid, durationS, reason));
  }

  banClient(clid: number, durationS: number, reason: string): Promise<void> {
    return this.command((t) => t.banClient(clid, durationS, reason));
  }

  async channelList(): Promise<Ts3Channel[]> {
    return this.command((t) => t.channelList());
  }

  /** Runs a command on the current transport through the rate-limited queue. */
  command<T>(fn: (transport: Ts3Transport) => Promise<T>): Promise<T> {
    return this.queue.run(() => {
      const transport = this.transport;
      if (!transport || this.currentState !== 'connected') throw new NotConnectedError();
      return fn(transport);
    });
  }

  /** Current reconnect delay for the given attempt (exported for tests and status pages). */
  backoffFor(attempt: number): number {
    const base = Math.min(this.maxBackoffMs, this.initialBackoffMs * 2 ** Math.max(0, attempt - 1));
    return Math.round(base * (1 + this.jitter * this.random()));
  }

  /** A method (not an inline comparison) because the state can change across `await`. */
  private isStopped(): boolean {
    return this.currentState === 'stopped';
  }

  private setState(state: ConnectionState): void {
    if (this.currentState === state || this.isStopped()) return;
    this.currentState = state;
    this.stateSince = this.nowS();
    if (state === 'connected') this.lastConnectedAt = this.stateSince;
    this.emit('stateChange', state);
  }

  private async run(): Promise<void> {
    while (!this.isStopped()) {
      if (this.attempt > 0) {
        const delay = this.backoffFor(this.attempt);
        this.setState('waiting');
        this.deps.logger.info({ attempt: this.attempt, delayMs: delay }, 'Reconnecting to TS3');
        await this.sleepInterruptible(delay);
        if (this.isStopped()) return;
      }
      this.setState('connecting');
      const connection = await this.connectOnce();
      if (connection) await connection.ended;
    }
  }

  /** Connects once; on success returns a promise that resolves when the connection ends. */
  private async connectOnce(): Promise<{ ended: Promise<void> } | undefined> {
    const transport = this.factory();
    try {
      await transport.connect();
    } catch (error) {
      this.attempt++;
      this.rememberError(error);
      this.deps.logger.warn({ err: error, attempt: this.attempt }, 'TS3 connection failed');
      transport.removeAllListeners();
      await transport.disconnect().catch(() => undefined);
      return undefined;
    }
    if (this.isStopped()) {
      await transport.disconnect().catch(() => undefined);
      return undefined;
    }

    this.transport = transport;
    this.attempt = 0;
    transport.on('clientConnect', (client) => {
      if (client.type !== CLIENT_TYPE_QUERY) this.emit('clientConnect', client);
    });
    transport.on('clientDisconnect', (event) => this.emit('clientDisconnect', event));
    transport.on('clientMoved', (event) => this.emit('clientMoved', event));

    const ended = new Promise<void>((resolve) => {
      this.connectionEnded = resolve;
    });
    transport.once('close', (error) => {
      this.handleClose(transport, error);
    });
    this.setState('connected');
    this.startKeepAlive(transport);
    this.deps.logger.info('Connected to TS3');
    this.emit('connected');
    return { ended };
  }

  private handleClose(transport: Ts3Transport, error: Error | undefined): void {
    if (this.transport !== transport) return;
    this.transport = undefined;
    this.connectionEnded?.();
    this.connectionEnded = undefined;
    this.stopKeepAlive();
    transport.removeAllListeners();
    this.queue.clear();
    this.attempt = Math.max(1, this.attempt);
    if (!this.isStopped()) {
      this.rememberError(error);
      this.deps.logger.warn({ err: error }, 'TS3 connection closed');
      this.setState('waiting');
      this.emit('disconnected', error);
    }
  }

  private startKeepAlive(transport: Ts3Transport): void {
    const setIntervalFn = this.deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
    this.keepAliveHandle = setIntervalFn(() => {
      this.command((t) => t.ping()).catch((error: unknown) => {
        if (this.transport !== transport) return;
        this.deps.logger.warn({ err: error }, 'TS3 keepalive failed, reconnecting');
        transport.emit('close', error instanceof Error ? error : new Error(String(error)));
        void transport.disconnect().catch(() => undefined);
      });
    }, this.keepAliveMs);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveHandle === undefined) return;
    const clearIntervalFn =
      this.deps.clearInterval ??
      ((handle: unknown) => {
        clearInterval(handle as NodeJS.Timeout);
      });
    clearIntervalFn(this.keepAliveHandle);
    this.keepAliveHandle = undefined;
  }

  private async sleepInterruptible(ms: number): Promise<void> {
    await Promise.race([
      this.clock.sleep(ms),
      new Promise<void>((resolve) => {
        this.wake = resolve;
      }),
    ]);
    this.wake = undefined;
  }
}
