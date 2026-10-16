import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { AlertNotifier } from '../../alerts/notifier.js';
import { escapeMarkdown } from '../../alerts/notifier.js';
import type { DbExecutor } from '../../db/repositories/index.js';
import { proxyChecks, proxyIps, type ProxyVerdict } from '../../db/schema.js';
import type { NormalizedIp } from '../../domain/ip.js';
import { fillTemplate } from '../../domain/support.js';
import {
  BAN_REASON_MAX,
  MESSAGE_MAX,
  ModuleActions,
  POKE_MAX,
  type AutomationDeps,
} from '../actions.js';
import type { BotClient, BotModule } from '../host.js';
import type { ProxyLookup } from '../proxycheck.js';
import { isExempt, loadModuleSettings, moduleBase } from '../settings.js';
import { clientLanguage, englishSection } from '../language.js';
import {
  englishInviteSchema,
  getVouch,
  inviteTexts,
  ProxyInvites,
  proxyInviteSchema,
  removeVouch,
  type InviteContext,
} from './proxy-invite.js';

export const PROXY_ACTIONS = ['none', 'message', 'poke', 'kick', 'ban', 'group', 'invite'] as const;

export const proxySettingsSchema = moduleBase.extend({
  /** What happens to a player who connects through a VPN or proxy. */
  action: z.enum(PROXY_ACTIONS).default('none'),
  /** Text for the player (message, poke) and reason of kick or ban. */
  message: z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_MAX)
    .default('VPN oder Proxy erkannt. Bitte melde dich bei einem Admin.'),
  /**
   * Server group set with the actions `group` and `invite` – for `invite` it is the group that
   * restricts the player until somebody vouched. Never a rank group.
   */
  groupId: z.number().int().positive().nullable().default(null),
  banDurationS: z
    .number()
    .int()
    .min(60)
    .max(30 * 86_400)
    .default(3600),
  /** Members of these server groups get a private message about every detection. */
  notifyGroupIds: z.array(z.number().int().positive()).max(50).default([]),
  /** `{name}` is the player's nickname. */
  notifyMessage: z.string().trim().min(1).max(MESSAGE_MAX).default('VPN/Proxy erkannt bei {name}.'),
  /** Players that are never checked, by internal id. */
  exemptUserIds: z.array(z.number().int().positive()).max(500).default([]),
  /** The invite flow of the action `invite`. */
  invite: proxyInviteSchema,
  /**
   * English texts for players outside the German-speaking countries (T12.1). The message to
   * the team stays in one language.
   */
  english: englishSection({
    message: z
      .string()
      .trim()
      .min(1)
      .max(MESSAGE_MAX)
      .default('VPN or proxy detected. Please contact an admin.'),
    invite: englishInviteSchema,
  }),
});

export type ProxySettings = z.infer<typeof proxySettingsSchema>;

export function loadProxySettings(db: DbExecutor): ProxySettings {
  return loadModuleSettings(db, 'proxy', proxySettingsSchema);
}

export function getProxyCheck(
  db: DbExecutor,
  userId: number,
): { verdict: ProxyVerdict; checkedAt: number } | undefined {
  return db
    .select({ verdict: proxyChecks.verdict, checkedAt: proxyChecks.checkedAt })
    .from(proxyChecks)
    .where(eq(proxyChecks.userId, userId))
    .get();
}

function setProxyCheck(db: DbExecutor, userId: number, verdict: ProxyVerdict, at: number): void {
  db.insert(proxyChecks)
    .values({ userId, verdict, checkedAt: at })
    .onConflictDoUpdate({ target: proxyChecks.userId, set: { verdict, checkedAt: at } })
    .run();
}

/**
 * Undoes a false alarm: the player counts as clean from now on (and is not checked again), and
 * the addresses first seen with them leave the local list.
 */
export function clearProxyVerdict(db: DbExecutor, userId: number, at: number): number {
  const removed = db.delete(proxyIps).where(eq(proxyIps.userId, userId)).run().changes;
  // Clean players need nobody to vouch for them.
  removeVouch(db, userId);
  setProxyCheck(db, userId, 'clean', at);
  return removed;
}

/** Loopback, private and link-local addresses: nothing an online service could know about. */
export function isPublicAddress(ip: NormalizedIp): boolean {
  const a = ip.address;
  if (ip.version === 4) {
    const [first = 0, second = 0] = a.split('.').map(Number);
    return !(
      first === 10 ||
      first === 127 ||
      first === 0 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 169 && second === 254) ||
      (first === 100 && second >= 64 && second <= 127)
    );
  }
  return !(
    a.startsWith('fc') ||
    a.startsWith('fd') ||
    a.startsWith('fe8') ||
    /^0000(:0000){6}:000[01]$/.test(a)
  );
}

/** Seconds between two warnings about an unreachable service. */
const WARN_INTERVAL_S = 600;

export interface ProxyDeps extends AutomationDeps {
  lookup: ProxyLookup;
  /** The automation host's view of a connection, for server groups and database id. */
  client: (clid: number) => BotClient | undefined;
  online: () => readonly BotClient[];
  notifier: Pick<AlertNotifier, 'notify'>;
}

/**
 * Proxy check (T10.10). Called with the address while the watcher still holds it in memory;
 * the module keeps only its keyed hash. Order: players known to be clean are skipped, then the
 * local list answers, and only otherwise the online service is asked. A hit puts the hash on
 * the local list. While the service is unreachable nothing happens and the player is checked
 * again on their next join.
 */
export class ProxyModule implements BotModule {
  readonly id = 'proxy';
  private lastWarningAt: number | undefined;
  private readonly running = new Set<Promise<void>>();
  private readonly invites: ProxyInvites;

  constructor(private readonly deps: ProxyDeps) {
    this.invites = new ProxyInvites(deps);
  }

  /** The module's own groups: the restricting one and the whitelist of the invite flow. */
  private actions(settings: ProxySettings): ModuleActions {
    const own = [settings.groupId, settings.invite.whitelistGroupId].filter(
      (group): group is number => group !== null,
    );
    return new ModuleActions(this.deps, {
      module: this.id,
      dryRun: settings.dryRun,
      ownGroupIds: own,
    });
  }

  private inviteContext(settings: ProxySettings): InviteContext | undefined {
    if (!settings.enabled || settings.action !== 'invite') return undefined;
    const { english } = settings;
    return {
      settings: settings.invite,
      english: english.enabled ? english.invite : undefined,
      language: (client) => clientLanguage(this.deps.database, client.userId, english.enabled),
      blockGroupId: settings.groupId,
      actions: this.actions(settings),
    };
  }

  /** Answers of the invite flow: a number from the player, yes or no from the sponsor. */
  async onMessage(client: BotClient, message: string): Promise<void> {
    const context = this.inviteContext(loadProxySettings(this.deps.database.db));
    if (context) await this.invites.onMessage(client, message, context);
  }

  async onLeft(client: BotClient): Promise<void> {
    const waiting = this.invites.onLeft(client);
    const settings = loadProxySettings(this.deps.database.db);
    const context = this.inviteContext(settings);
    if (!waiting || !context) return;
    await context.actions.message(
      waiting,
      fillTemplate(inviteTexts(context, waiting).timeoutMessage, { name: client.nickname }),
      'Einladung: Bürge hat den Server verlassen',
    );
  }

  /** Sponsors who did not answer in time are dropped with the poll. */
  async onSynced(): Promise<void> {
    const context = this.inviteContext(loadProxySettings(this.deps.database.db));
    if (context) await this.invites.expire(context);
  }

  /** Resolves when all started checks are done (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.running.size > 0) await Promise.all([...this.running]);
  }

  /**
   * Entry point for the watcher's IP step. `ip` must not be stored or logged; it is only
   * handed to the lookup.
   */
  inspect(target: { clid: number; userId: number }, ip: NormalizedIp, ipHash: Buffer): void {
    const task: Promise<void> = this.check(target, ip, ipHash)
      .catch((error: unknown) => {
        this.deps.logger.error({ err: error }, 'Proxy check failed');
      })
      .finally(() => this.running.delete(task));
    this.running.add(task);
  }

  private async check(
    target: { clid: number; userId: number },
    ip: NormalizedIp,
    ipHash: Buffer,
  ): Promise<void> {
    const { db } = this.deps.database;
    const settings = loadProxySettings(db);
    if (!settings.enabled || settings.exemptUserIds.includes(target.userId)) return;
    const client = this.deps.client(target.clid);
    if (client?.userId !== target.userId || isExempt(settings, client.serverGroups)) return;
    if (!isPublicAddress(ip)) return;
    // Somebody vouched: the whitelist group says so; without such a group, our own record does.
    const whitelist = settings.invite.whitelistGroupId;
    const vouched =
      whitelist === null
        ? getVouch(db, target.userId) !== undefined
        : client.serverGroups.includes(whitelist);
    if (settings.action === 'invite' && vouched) return;
    if (getProxyCheck(db, target.userId)?.verdict === 'clean') return;

    const listed = db
      .select({ kind: proxyIps.kind })
      .from(proxyIps)
      .where(eq(proxyIps.ipHash, ipHash))
      .get();
    if (listed) {
      setProxyCheck(db, target.userId, 'proxy', this.deps.now());
      await this.detected(settings, client, listed.kind ?? undefined, 'lokale Liste');
      return;
    }

    const result = await this.deps.lookup(ip.address);
    const now = this.deps.now();
    if (result.verdict === 'unavailable') {
      if (this.lastWarningAt === undefined || now - this.lastWarningAt >= WARN_INTERVAL_S) {
        this.lastWarningAt = now;
        this.deps.logger.warn({ reason: result.reason }, 'Proxy check service unavailable');
      }
      return;
    }
    if (result.verdict === 'clean') {
      setProxyCheck(db, target.userId, 'clean', now);
      // Back without a proxy: the restriction of an earlier visit goes.
      const restricted = settings.groupId;
      if (
        restricted !== null &&
        (settings.action === 'invite' || settings.action === 'group') &&
        client.serverGroups.includes(restricted)
      ) {
        await this.actions(settings).removeGroup(client, restricted, 'ohne Proxy verbunden');
      }
      return;
    }
    this.deps.database.sqlite.transaction(() => {
      db.insert(proxyIps)
        .values({ ipHash, kind: result.kind ?? null, userId: target.userId, flaggedAt: now })
        .onConflictDoNothing()
        .run();
      setProxyCheck(db, target.userId, 'proxy', now);
    })();
    await this.detected(settings, client, result.kind, 'Online-Dienst');
  }

  private async detected(
    settings: ProxySettings,
    client: BotClient,
    kind: string | undefined,
    source: string,
  ): Promise<void> {
    const actions = this.actions(settings);
    const detail = `${kind ?? 'Proxy'} (${source})`;
    actions.note('proxy.detected', client, detail);

    const english =
      clientLanguage(this.deps.database, client.userId, settings.english.enabled) === 'en';
    const text = english ? settings.english.message : settings.message;
    switch (settings.action) {
      case 'message':
        await actions.message(client, text, detail);
        break;
      case 'poke':
        await actions.poke(client, text.slice(0, POKE_MAX), detail);
        break;
      case 'kick':
        await actions.kick(client, text, detail);
        break;
      case 'ban':
        await actions.ban(client, settings.banDurationS, text.slice(0, BAN_REASON_MAX), detail);
        break;
      case 'group':
        if (settings.groupId !== null && !client.serverGroups.includes(settings.groupId)) {
          await actions.addGroup(client, settings.groupId, detail);
        }
        await actions.message(client, text, detail);
        break;
      case 'invite': {
        if (settings.groupId !== null && !client.serverGroups.includes(settings.groupId)) {
          const added = await actions.addGroup(client, settings.groupId, detail);
          if (added) client.serverGroups = [...client.serverGroups, settings.groupId];
        }
        const context = this.inviteContext(settings);
        if (context) await this.invites.start(client, context);
        break;
      }
      case 'none':
        break;
    }

    const notice = fillTemplate(settings.notifyMessage, { name: client.nickname });
    for (const member of this.deps.online()) {
      if (member.clid === client.clid) continue;
      if (member.serverGroups.some((group) => settings.notifyGroupIds.includes(group))) {
        await actions.message(member, notice, `Meldung zu „${client.nickname}“`);
      }
    }
    if (!settings.dryRun) {
      this.deps.notifier.notify(
        'proxy.detected',
        `🛡️ **VPN/Proxy erkannt:** ${escapeMarkdown(client.nickname)}${kind ? ` (${escapeMarkdown(kind)})` : ''}.`,
      );
    }
  }
}
