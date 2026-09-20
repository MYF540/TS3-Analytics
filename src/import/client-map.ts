/**
 * Maps the client database ids from the server logs to UIDs (T8.3). The logs only carry the
 * database id, so without this map an import would have no idea who a session belongs to.
 *
 * Source is a **copy** of `ts3server.sqlitedb`, opened read-only. Its table `clients` holds one
 * row per known account of a virtual server; `client_id` is the id the logs print as `(id:…)`.
 */
import Database from 'better-sqlite3';
import { recordNickname, upsertUser, type DbExecutor } from '../db/repositories/index.js';

export interface ClientRecord {
  dbid: number;
  uid: string;
  nickname: string | null;
  /** Last connection according to the server database, 0 when it never happened. */
  lastConnected: number;
}

export type ClientMap = Map<number, ClientRecord>;

/** TS3 UIDs are 28 characters of base64. Query logins like `serveradmin` are not. */
export function isClientUid(uid: string): boolean {
  return /^[A-Za-z0-9+/]{27}=$/.test(uid);
}

export class ClientMapError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientMapError';
  }
}

/**
 * Reads the accounts of one virtual server. Query accounts are left out – they never count
 * (AGENTS.md), and their "UID" is a login name, not a UID.
 */
export function readClientMap(path: string, options: { serverId: number }): ClientMap {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new ClientMapError(`${path} is not readable: ${String(error)}`);
  }
  try {
    const hasTable = sqlite
      .prepare(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'clients'`)
      .pluck()
      .get() as number;
    if (hasTable === 0) {
      throw new ClientMapError(`${path} has no table "clients" – is it really ts3server.sqlitedb?`);
    }
    const rows = sqlite
      .prepare(
        `SELECT client_id AS dbid, client_unique_id AS uid, client_nickname AS nickname,
                client_lastconnected AS lastConnected
         FROM clients WHERE server_id = ?`,
      )
      .all(options.serverId) as {
      dbid: number;
      uid: string | null;
      nickname: string | null;
      lastConnected: number | null;
    }[];
    const map: ClientMap = new Map();
    for (const row of rows) {
      if (!row.uid || !isClientUid(row.uid)) continue;
      map.set(row.dbid, {
        dbid: row.dbid,
        uid: row.uid,
        nickname: row.nickname,
        lastConnected: row.lastConnected ?? 0,
      });
    }
    return map;
  } finally {
    sqlite.close();
  }
}

/** UID of a player whose database id is not in the map; linkable later (T5.3). */
export function placeholderUid(dbid: number): string {
  return `unknown-dbid-${String(dbid)}`;
}

export function isPlaceholderUid(uid: string): boolean {
  return uid.startsWith('unknown-dbid-');
}

export interface ResolverCounters {
  /** Database ids that the map knew. */
  resolved: number;
  /** Database ids without an account – a placeholder was created. */
  placeholders: number;
}

/**
 * Turns database ids into our `users.id`, creating a row on first sight. Results are cached, so
 * a run over millions of log lines touches the database once per player.
 */
export class DbidResolver {
  private readonly cache = new Map<number, number>();
  readonly counters: ResolverCounters = { resolved: 0, placeholders: 0 };
  /** Database ids that could not be resolved, for the report. */
  readonly unresolved = new Set<number>();

  constructor(
    private readonly db: DbExecutor,
    private readonly map: ClientMap,
  ) {}

  /** `nick` is the name from the log line; it is only used for placeholders. */
  resolve(dbid: number, seenAt: number, nick?: string): number {
    const cached = this.cache.get(dbid);
    if (cached !== undefined) return cached;

    const record = this.map.get(dbid);
    const uid = record?.uid ?? placeholderUid(dbid);
    if (record) {
      this.counters.resolved++;
    } else {
      this.counters.placeholders++;
      this.unresolved.add(dbid);
    }
    const userId = upsertUser(this.db, { uid, dbid, seenAt });
    const nickname = record?.nickname ?? nick;
    if (nickname !== undefined && nickname !== '') {
      recordNickname(this.db, userId, nickname, seenAt);
    }
    this.cache.set(dbid, userId);
    return userId;
  }
}
