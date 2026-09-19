import { z } from 'zod';
import type { AlertNotifier } from '../alerts/notifier.js';
import { escapeMarkdown } from '../alerts/notifier.js';
import type { AppDatabase } from '../db/client.js';
import { getSetting, listRanks, setSetting, type Rank } from '../db/repositories/index.js';
import { assertManaged, groupDiff, isEmptyDiff, type GroupDiff } from '../domain/rank-groups.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Connection } from '../ts3/connection.js';
import type { Ts3Client } from '../ts3/types.js';
import type { OnlineClient, TrackerListener } from '../watcher/tracker.js';
import { planOptions, planRanks } from './planner.js';
import { loadRankSettings, type RankSettings } from './settings.js';

export const LAST_RUN_KEY = 'ranks.lastRun';
const FINGERPRINT_KEY = 'ranks.fingerprint';

export interface RankRunResult {
  /** Why nothing ran (not connected, no ranks), if so. */
  skipped?: 'not_connected' | 'no_ranks';
  full: boolean;
  dryRun: boolean;
  /** Persons checked. */
  checked: number;
  /** Persons whose rank changed. */
  changed: number;
  /** Server-group commands sent (0 in dry-run mode). */
  commands: number;
  /** Accounts marked for their next join. */
  pending: number;
  failed: number;
}

export interface RankJobDeps {
  database: AppDatabase;
  connection: Pick<
    Ts3Connection,
    'clientList' | 'addToServerGroup' | 'removeFromServerGroup' | 'sendMessage' | 'isConnected'
  >;
  notifier: Pick<AlertNotifier, 'notify'>;
  logger: Logger;
  /** UTC seconds. */
  now?: () => number;
}

interface LiveAccount {
  clids: number[];
  dbid: number;
  groups: number[];
}

function parseGroups(json: string | null): number[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is number => typeof v === 'number') : [];
  } catch {
    return [];
  }
}

/** A diff promotes when the added rank group is higher than every removed one. */
function isPromotion(diff: GroupDiff, ladder: readonly Rank[]): boolean {
  const order = (group: number) => ladder.find((r) => r.serverGroupId === group)?.sortOrder ?? 0;
  const [added] = diff.add;
  if (added === undefined) return false;
  return diff.remove.every((g) => order(g) < order(added));
}

function fingerprint(database: AppDatabase, settings: RankSettings, ladder: Rank[]): string {
  const overrides = database.sqlite
    .prepare(
      'SELECT user_id, frozen_rank_id, bonus_s, excluded FROM rank_overrides ORDER BY user_id',
    )
    .all();
  const persons = database.sqlite
    .prepare(
      `SELECT m.user_id, p.primary_user_id FROM person_members m JOIN persons p ON p.id = m.person_id
       ORDER BY m.user_id`,
    )
    .all();
  return JSON.stringify({
    ladder,
    countMode: settings.countMode,
    excluded: settings.excludedGroupIds,
    dryRun: settings.dryRun,
    overrides,
    persons,
  });
}

/**
 * Rank job (T6.3). Sets the rank server group of every person according to the rank engine and
 * removes other rank groups – and never touches groups that are not in `ranks`. In dry-run mode
 * (the default) it only records what it would do. Online accounts are changed right away (based
 * on their live groups); offline accounts are marked pending and changed on their next join.
 */
export class RankJob implements TrackerListener {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<RankRunResult> | undefined;
  private readonly joins = new Set<Promise<void>>();

  constructor(private readonly deps: RankJobDeps) {}

  start(): void {
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** Resolves when running join handlers are done (tests, shutdown). */
  async idle(): Promise<void> {
    await Promise.all([...this.joins]);
  }

  run(options: { full?: boolean } = {}): Promise<RankRunResult> {
    this.running ??= this.runOnce(options.full ?? false).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  onJoined(client: OnlineClient, source: Ts3Client): void {
    const task = this.applyPending(client, source)
      .catch((error: unknown) => {
        this.deps.logger.warn({ err: error, userId: client.userId }, 'Pending rank not applied');
      })
      .finally(() => this.joins.delete(task));
    this.joins.add(task);
  }

  private now(): number {
    return this.deps.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private schedule(): void {
    const minutes = loadRankSettings(this.deps.database.db).intervalMinutes;
    this.timer = setTimeout(() => {
      void this.run()
        .catch((error: unknown) => {
          this.deps.logger.error({ err: error }, 'Rank job failed');
        })
        .finally(() => {
          if (this.timer) this.schedule();
        });
    }, minutes * 60_000);
  }

  private async liveAccounts(): Promise<Map<string, LiveAccount>> {
    const clients = await this.deps.connection.clientList();
    const byUid = new Map<string, LiveAccount>();
    for (const c of clients) {
      const account = byUid.get(c.uid);
      if (account) account.clids.push(c.clid);
      else byUid.set(c.uid, { clids: [c.clid], dbid: c.dbid, groups: [...c.serverGroups] });
    }
    return byUid;
  }

  private async applyDiff(dbid: number, diff: GroupDiff, managed: ReadonlySet<number>) {
    assertManaged(diff, managed);
    const { connection } = this.deps;
    for (const group of diff.remove) await connection.removeFromServerGroup(dbid, group);
    for (const group of diff.add) await connection.addToServerGroup(dbid, group);
    return diff.remove.length + diff.add.length;
  }

  private async promote(ladder: readonly Rank[], rankId: number, clids: number[], name: string) {
    const settings = loadRankSettings(this.deps.database.db);
    const rank = ladder.find((r) => r.id === rankId);
    if (!rank) return;
    if (settings.promotionMessage.enabled) {
      const text = settings.promotionMessage.text.replaceAll('{rank}', rank.name);
      for (const clid of clids) {
        await this.deps.connection.sendMessage(clid, text).catch((error: unknown) => {
          this.deps.logger.warn({ err: error }, 'Promotion message not sent');
        });
      }
    }
    this.deps.notifier.notify(
      'rank.promoted',
      `⬆️ **Rang-Aufstieg:** ${escapeMarkdown(name)} ist jetzt „${escapeMarkdown(rank.name)}“.`,
    );
  }

  private async runOnce(forceFull: boolean): Promise<RankRunResult> {
    const { database, logger } = this.deps;
    const { sqlite, db } = database;
    const settings = loadRankSettings(db);
    const ladder = listRanks(sqlite);
    const result: RankRunResult = {
      full: false,
      dryRun: settings.dryRun,
      checked: 0,
      changed: 0,
      commands: 0,
      pending: 0,
      failed: 0,
    };
    if (ladder.length === 0) return { ...result, skipped: 'no_ranks' };
    if (!this.deps.connection.isConnected) return { ...result, skipped: 'not_connected' };

    const now = this.now();
    const lastRun = getSetting(db, LAST_RUN_KEY, z.number().int());
    const print = fingerprint(database, settings, ladder);
    const full =
      forceFull || lastRun === undefined || getSetting(db, FINGERPRINT_KEY, z.string()) !== print;
    result.full = full;

    const live = await this.liveAccounts();
    const users = sqlite
      .prepare('SELECT id, uid, dbid, server_groups AS groups, last_seen AS lastSeen FROM users')
      .all() as {
      id: number;
      uid: string;
      dbid: number | null;
      groups: string | null;
      lastSeen: number;
    }[];
    const byId = new Map(users.map((u) => [u.id, u]));
    // Live groups are more current than those stored at the last join (excluded groups!).
    const updateGroups = sqlite.prepare('UPDATE users SET server_groups = ? WHERE id = ?');
    for (const u of users) {
      const account = live.get(u.uid);
      if (!account) continue;
      const json = JSON.stringify(account.groups);
      if (json !== u.groups) {
        updateGroups.run(json, u.id);
        u.groups = json;
      }
    }
    const onlineIds = users.filter((u) => live.has(u.uid)).map((u) => u.id);
    const scope = full
      ? undefined
      : [
          ...new Set([
            ...onlineIds,
            ...users.filter((u) => u.lastSeen >= lastRun).map((u) => u.id),
          ]),
        ];

    const { entries } = planRanks(sqlite, settings, planOptions(db), scope);
    const managed = new Set(ladder.map((r) => r.serverGroupId));
    const nickname = sqlite
      .prepare('SELECT nick FROM nicknames WHERE user_id = ? ORDER BY last_seen DESC LIMIT 1')
      .pluck();
    const saveState = sqlite.prepare(
      `INSERT INTO rank_state (user_id, rank_id, pending, decided_at, applied_at)
       VALUES (@userId, @rankId, @pending, @now, @appliedAt)
       ON CONFLICT (user_id) DO UPDATE SET rank_id = excluded.rank_id, pending = excluded.pending,
         decided_at = excluded.decided_at,
         applied_at = coalesce(excluded.applied_at, rank_state.applied_at)`,
    );
    const saveGroups = sqlite.prepare('UPDATE users SET server_groups = ? WHERE id = ?');
    const history = sqlite.prepare(
      `INSERT INTO rank_history (at, user_id, from_rank_id, to_rank_id, ranking_s, dry_run, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );

    for (const entry of entries) {
      if (entry.decision.kind === 'skip') continue;
      result.checked++;
      const target = entry.decision.rankId;
      const targetGroup = ladder.find((r) => r.id === target)?.serverGroupId ?? null;
      const changed = !entry.known || entry.currentRankId !== target;
      let pending = 0;
      let failed = 0;
      let promotedClids: number[] = [];
      const commandsBefore = result.commands;

      for (const userId of entry.userIds) {
        const user = byId.get(userId);
        if (!user) continue;
        const account = live.get(user.uid);
        const groups = account?.groups ?? parseGroups(user.groups);
        const diff = groupDiff(groups, targetGroup, managed);
        let appliedAt: number | null = null;
        let isPending = false;
        if (!isEmptyDiff(diff) && !settings.dryRun) {
          if (account) {
            try {
              result.commands += await this.applyDiff(account.dbid, diff, managed);
              appliedAt = now;
              const next = groups.filter((g) => !diff.remove.includes(g)).concat(diff.add);
              saveGroups.run(JSON.stringify(next), userId);
              if (isPromotion(diff, ladder)) promotedClids = promotedClids.concat(account.clids);
            } catch (error) {
              failed++;
              isPending = true;
              logger.warn({ err: error, userId }, 'Rank groups not changed');
            }
          } else {
            isPending = true;
          }
        }
        if (isPending) pending++;
        saveState.run({ userId, rankId: target, pending: isPending ? 1 : 0, now, appliedAt });
      }

      result.pending += pending;
      result.failed += failed;
      // After a dry-run the decision is known already; applying it still belongs in the history.
      const applied = result.commands > commandsBefore;
      if (changed) result.changed++;
      if (changed || applied) {
        const outcome = settings.dryRun
          ? 'dry_run'
          : failed > 0
            ? 'failed'
            : pending > 0
              ? 'pending'
              : 'applied';
        history.run(
          now,
          entry.primaryUserId,
          entry.currentRankId,
          target,
          entry.decision.effectiveS,
          settings.dryRun ? 1 : 0,
          outcome,
        );
      }
      if (promotedClids.length > 0 && target !== null) {
        const name =
          (nickname.get(entry.primaryUserId) as string | undefined) ??
          byId.get(entry.primaryUserId)?.uid ??
          '';
        await this.promote(ladder, target, promotedClids, name);
      }
    }

    setSetting(db, LAST_RUN_KEY, now, now);
    setSetting(db, FINGERPRINT_KEY, print, now);
    logger.info(result, 'Rank job finished');
    return result;
  }

  private async applyPending(client: OnlineClient, source: Ts3Client): Promise<void> {
    const { database, logger } = this.deps;
    const { sqlite, db } = database;
    const settings = loadRankSettings(db);
    if (settings.dryRun) return;
    const state = sqlite
      .prepare('SELECT rank_id AS rankId, pending FROM rank_state WHERE user_id = ?')
      .get(client.userId) as { rankId: number | null; pending: number } | undefined;
    if (!state || state.pending !== 1) return;
    const ladder = listRanks(sqlite);
    const managed = new Set(ladder.map((r) => r.serverGroupId));
    const targetGroup = ladder.find((r) => r.id === state.rankId)?.serverGroupId ?? null;
    const diff = groupDiff(source.serverGroups, targetGroup, managed);
    if (!isEmptyDiff(diff)) await this.applyDiff(source.dbid, diff, managed);
    const now = this.now();
    sqlite
      .prepare('UPDATE rank_state SET pending = 0, applied_at = ? WHERE user_id = ?')
      .run(now, client.userId);
    sqlite
      .prepare('UPDATE users SET server_groups = ? WHERE id = ?')
      .run(
        JSON.stringify(
          source.serverGroups.filter((g) => !diff.remove.includes(g)).concat(diff.add),
        ),
        client.userId,
      );
    logger.info(
      { userId: client.userId, commands: diff.add.length + diff.remove.length },
      'Pending rank applied',
    );
    if (state.rankId !== null && isPromotion(diff, ladder)) {
      await this.promote(ladder, state.rankId, [client.clid], client.nickname);
    }
  }
}
