import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import type { Config } from '../config/config.js';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export interface AppDatabase {
  /** Raw connection for PRAGMAs, bulk statements and FTS queries. */
  readonly sqlite: Database.Database;
  /** Typed Drizzle query builder. */
  readonly db: Db;
  close(): void;
}

export type DatabaseOptions = Config['database'];

export const IN_MEMORY = ':memory:';

// Same relative location from src/db (tsx, tests) and dist/db (build).
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

const MB = 1024 * 1024;

/** Applies the connection settings from AGENTS.md ("Datenumfang & Performance"). */
export function applyPragmas(sqlite: Database.Database, options: DatabaseOptions): void {
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('temp_store = MEMORY');
  sqlite.pragma('busy_timeout = 5000');
  // Negative cache_size is in KiB.
  sqlite.pragma(`cache_size = ${String(-options.cacheSizeMb * 1024)}`);
  sqlite.pragma(`mmap_size = ${String(options.mmapSizeMb * MB)}`);
}

/** Opens (and creates) the database file with PRAGMAs applied. Does not migrate. */
export function openDatabase(options: DatabaseOptions): AppDatabase {
  if (options.path !== IN_MEMORY) mkdirSync(dirname(options.path), { recursive: true });
  const sqlite = new Database(options.path);
  applyPragmas(sqlite, options);
  const db = drizzle(sqlite, { schema });
  return {
    sqlite,
    db,
    close: () => {
      sqlite.close();
    },
  };
}

/** Runs all pending Drizzle migrations from `/drizzle`. Idempotent. */
export function runMigrations(database: AppDatabase): void {
  migrate(database.db, { migrationsFolder: MIGRATIONS_FOLDER });
}
