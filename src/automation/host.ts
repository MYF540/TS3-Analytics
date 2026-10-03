import type { AutomationModule } from '../db/schema.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Client } from '../ts3/types.js';
import type { MoveCause, OnlineClient, TrackerListener } from '../watcher/tracker.js';
import type { ActionTarget } from './actions.js';

/** An online client as bot modules see it. */
export interface BotClient extends ActionTarget {
  uid: string;
  nickname: string;
  channelId: number;
  /** Server groups as of the join or the last poll. */
  serverGroups: readonly number[];
}

export interface JoinInfo {
  /**
   * True when the client was not seen joining but found by a client-list sync (start of the
   * service, reconnect of the query connection) or carried over a restart.
   */
  discovered: boolean;
}

type Result = void | Promise<void>;

/** A bot module (phase 10). Every hook is optional; errors are caught by the host. */
export interface BotModule {
  readonly id: AutomationModule;
  onJoin?(client: BotClient, info: JoinInfo, at: number): Result;
  /** The nickname changed; noticed by the poll, so up to one poll interval late. */
  onNickname?(client: BotClient, previous: string, at: number): Result;
  /** `cause` is missing when the move was only noticed by the poll. */
  onMoved?(
    client: BotClient,
    previousChannelId: number,
    cause: MoveCause | undefined,
    at: number,
  ): Result;
  onLeft?(client: BotClient, at: number): Result;
  /** The client wrote a private message to the bot. */
  onMessage?(client: BotClient, message: string, at: number): Result;
  /** After every client-list poll: server groups and channels of everyone are up to date. */
  onSynced?(): Result;
}

/**
 * Hands what the session tracker sees to the bot modules. Keeps the details modules need but
 * the tracker does not (database id, server groups) and shields the watcher from their errors.
 */
export class AutomationHost implements TrackerListener {
  private readonly modules: BotModule[] = [];
  private readonly clients = new Map<number, BotClient>();
  private readonly running = new Set<Promise<void>>();
  private syncing = false;

  constructor(private readonly logger: Logger) {}

  register(module: BotModule): void {
    this.modules.push(module);
  }

  /** Online clients as the modules see them. */
  get online(): readonly BotClient[] {
    return [...this.clients.values()];
  }

  get(clid: number): BotClient | undefined {
    return this.clients.get(clid);
  }

  /** Resolves when all running hooks are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  onSyncStart(): void {
    this.syncing = true;
  }

  onSyncEnd(): void {
    this.syncing = false;
    this.each('onSynced', (module) => module.onSynced?.());
  }

  onJoined(client: OnlineClient, source: Ts3Client, at: number): void {
    const bot = this.remember(client, source);
    const info = { discovered: this.syncing };
    this.each('onJoin', (module) => module.onJoin?.(bot, info, at));
  }

  onResumed(client: OnlineClient, source: Ts3Client, at: number): void {
    const bot = this.remember(client, source);
    this.each('onJoin', (module) => module.onJoin?.(bot, { discovered: true }, at));
  }

  onObserved(client: OnlineClient, source: Ts3Client): void {
    const known = this.clients.get(client.clid);
    if (known) known.serverGroups = source.serverGroups;
    else this.remember(client, source);
  }

  onNicknameChanged(client: OnlineClient, previous: string, at: number): void {
    const bot = this.clients.get(client.clid);
    if (!bot) return;
    bot.nickname = client.nickname;
    this.each('onNickname', (module) => module.onNickname?.(bot, previous, at));
  }

  onMoved(client: OnlineClient, previousChannelId: number, at: number, cause?: MoveCause): void {
    const bot = this.clients.get(client.clid);
    if (!bot) return;
    bot.channelId = client.channelId;
    this.each('onMoved', (module) => module.onMoved?.(bot, previousChannelId, cause, at));
  }

  /** A private message to the bot; messages of clients the tracker does not know are dropped. */
  onTextMessage(event: { clid: number; message: string }, at: number): void {
    const bot = this.clients.get(event.clid);
    if (!bot) return;
    this.each('onMessage', (module) => module.onMessage?.(bot, event.message, at));
  }

  onLeaving(client: OnlineClient, at: number): void {
    const bot = this.clients.get(client.clid);
    if (!bot) return;
    this.clients.delete(client.clid);
    this.each('onLeft', (module) => module.onLeft?.(bot, at));
  }

  private remember(client: OnlineClient, source: Ts3Client): BotClient {
    const bot: BotClient = {
      clid: client.clid,
      userId: client.userId,
      dbid: source.dbid,
      uid: client.uid,
      nickname: client.nickname,
      channelId: client.channelId,
      serverGroups: source.serverGroups,
    };
    this.clients.set(client.clid, bot);
    return bot;
  }

  private each(hook: string, call: (module: BotModule) => Result): void {
    for (const module of this.modules) {
      const failed = (error: unknown) => {
        this.logger.error({ err: error, module: module.id, hook }, 'Bot module failed');
      };
      try {
        const result = call(module);
        if (result === undefined) continue;
        const task: Promise<void> = result.catch(failed).finally(() => this.running.delete(task));
        this.running.add(task);
      } catch (error) {
        failed(error);
      }
    }
  }
}
