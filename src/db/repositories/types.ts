import type { RunResult } from 'better-sqlite3';
import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from '../schema.js';

/**
 * A database handle or an open transaction. Repository functions accept either, so callers can
 * batch several writes into one transaction (`db.transaction((tx) => ...)`).
 */
export type DbExecutor = BaseSQLiteDatabase<'sync', RunResult, typeof schema>;

/** UTC Unix timestamp in seconds. */
export type UnixSeconds = number;
