import type { AppDatabase } from '../db/client.js';
import { hashIp, normalizeIp } from '../domain/ip.js';
import type { Logger } from '../logging/logger.js';
import type { Ts3Connection } from '../ts3/connection.js';
import type { Ts3Ban } from '../ts3/types.js';

export interface BanSyncResult {
  /** Bans seen for the first time. */
  added: number;
  /** Bans no longer on the server (lifted or expired). */
  removed: number;
  /** Bans on the server right now. */
  active: number;
}

/**
 * Mirrors the ban list into `bans` in one transaction. Plain IPs are hashed here and never
 * leave this function (AGENTS.md rule 1); IP rules that are patterns only set `ip_pattern`.
 * Bans missing from the list get `removed_at`; bans that show up again are reactivated.
 */
export function applyBanList(
  database: AppDatabase,
  bans: readonly Ts3Ban[],
  hmacSecret: string,
  now: number,
): BanSyncResult {
  const { sqlite } = database;
  const known = sqlite.prepare('SELECT 1 FROM bans WHERE id = ?').pluck();
  const userByUid = sqlite.prepare('SELECT id FROM users WHERE uid = ?').pluck();
  const upsert = sqlite.prepare(`
    INSERT INTO bans (id, uid, user_id, ip_hash, subnet_hash, ip_pattern, name_pattern,
      last_nickname, reason, invoker_name, invoker_uid, created_at, duration_s, enforcements,
      first_synced, last_synced, removed_at)
    VALUES (@id, @uid, @userId, @ipHash, @subnetHash, @ipPattern, @namePattern, @lastNickname,
      @reason, @invokerName, @invokerUid, @createdAt, @durationS, @enforcements, @now, @now, NULL)
    ON CONFLICT (id) DO UPDATE SET
      uid = excluded.uid, user_id = excluded.user_id, ip_hash = excluded.ip_hash,
      subnet_hash = excluded.subnet_hash, ip_pattern = excluded.ip_pattern,
      name_pattern = excluded.name_pattern, last_nickname = excluded.last_nickname,
      reason = excluded.reason, invoker_name = excluded.invoker_name,
      invoker_uid = excluded.invoker_uid, created_at = excluded.created_at,
      duration_s = excluded.duration_s, enforcements = excluded.enforcements,
      last_synced = excluded.last_synced, removed_at = NULL`);
  const markRemoved = sqlite.prepare(`
    UPDATE bans SET removed_at = ?
    WHERE removed_at IS NULL AND id NOT IN (SELECT value FROM json_each(?))`);

  return sqlite.transaction(() => {
    let added = 0;
    for (const ban of bans) {
      if (!known.get(ban.banId)) added++;
      const ip = ban.ip === undefined ? undefined : normalizeIp(ban.ip);
      const hashes = ip ? hashIp(ip, hmacSecret) : undefined;
      upsert.run({
        id: ban.banId,
        uid: ban.uid ?? null,
        userId:
          ban.uid === undefined ? null : ((userByUid.get(ban.uid) as number | undefined) ?? null),
        ipHash: hashes?.ipHash ?? null,
        subnetHash: hashes?.subnetHash ?? null,
        ipPattern: ban.ip !== undefined && !ip ? 1 : 0,
        namePattern: ban.name ?? null,
        lastNickname: ban.lastNickname ?? null,
        reason: ban.reason ?? null,
        invokerName: ban.invokerName ?? null,
        invokerUid: ban.invokerUid ?? null,
        createdAt: ban.createdAt,
        durationS: ban.durationS,
        enforcements: ban.enforcements,
        now,
      });
    }
    const removed = markRemoved.run(now, JSON.stringify(bans.map((b) => b.banId))).changes;
    return { added, removed, active: bans.length };
  })();
}

export interface BanSyncDeps {
  database: AppDatabase;
  connection: Ts3Connection;
  hmacSecret: string;
  logger: Logger;
  intervalS: number;
  now?: () => number;
  /** Called after a sync that added or removed bans (e.g. to rerun the flag detection). */
  onChange?: (result: BanSyncResult) => void;
}

/** Reads the ban list after every (re)connect and then every `intervalS` seconds (T5.1). */
export class BanSync {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<BanSyncResult | undefined> | undefined;
  private readonly onConnected = () => {
    void this.sync();
  };

  constructor(private readonly deps: BanSyncDeps) {}

  start(): void {
    this.deps.connection.on('connected', this.onConnected);
    this.timer = setInterval(() => {
      if (this.deps.connection.isConnected) void this.sync();
    }, this.deps.intervalS * 1000);
    if (this.deps.connection.isConnected) void this.sync();
  }

  stop(): void {
    this.deps.connection.off('connected', this.onConnected);
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One sync; concurrent calls share the running one. Failures are logged, never thrown. */
  sync(): Promise<BanSyncResult | undefined> {
    this.running ??= this.syncOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async syncOnce(): Promise<BanSyncResult | undefined> {
    const { database, connection, hmacSecret, logger } = this.deps;
    try {
      const bans = await connection.banList();
      const now = this.deps.now?.() ?? Math.floor(Date.now() / 1000);
      const result = applyBanList(database, bans, hmacSecret, now);
      logger.info(result, 'Ban list synced');
      if (result.added > 0 || result.removed > 0) this.deps.onChange?.(result);
      return result;
    } catch (error) {
      // Without a complete list nothing is marked as removed.
      logger.warn({ err: error }, 'Ban list sync failed');
      return undefined;
    }
  }
}
