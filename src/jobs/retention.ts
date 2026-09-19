/**
 * Data retention and database maintenance (T2.6). Only raw/short-lived data is deleted;
 * aggregates (`user_daily_stats`, `user_totals`, `server_hourly`) are never touched.
 */
import type Database from 'better-sqlite3';
import { SEGMENTS_PRUNED_BEFORE_KEY, segmentsPrunedBefore } from '../db/aggregates.js';
import type { AppDatabase } from '../db/client.js';
import { setSetting } from '../db/repositories/index.js';

export const MINUTELY_RETENTION_DAYS = 14;
const DAY = 86_400;
const BATCH = 10_000;

export interface RetentionOptions {
  ipRetentionDays: number;
  /** 0 keeps activity segments forever. */
  segmentRetentionMonths: number;
}

export interface RetentionResult {
  ipSeen: number;
  serverMinutely: number;
  segments: number;
}

/** Deletes in batches so a large first run does not hold the write lock for long. */
function deleteInBatches(sqlite: Database.Database, sql: string, ...params: unknown[]): number {
  const stmt = sqlite.prepare(sql);
  let total = 0;
  for (;;) {
    const { changes } = stmt.run(...params, BATCH);
    total += changes;
    if (changes < BATCH) return total;
  }
}

/** Subtracts whole calendar months (UTC is precise enough for a retention cutoff). */
export function monthsBefore(ts: number, months: number): number {
  const date = new Date(ts * 1000);
  date.setUTCMonth(date.getUTCMonth() - months);
  return Math.floor(date.getTime() / 1000);
}

export function runRetention(
  database: AppDatabase,
  options: RetentionOptions,
  now: number,
): RetentionResult {
  const { sqlite } = database;
  const ipSeen = sqlite
    .prepare(`DELETE FROM ip_seen WHERE last_seen < ?`)
    .run(now - options.ipRetentionDays * DAY).changes;

  const serverMinutely = deleteInBatches(
    sqlite,
    `DELETE FROM server_minutely WHERE ts IN (SELECT ts FROM server_minutely WHERE ts < ? LIMIT ?)`,
    now - MINUTELY_RETENTION_DAYS * DAY,
  );

  let segments = 0;
  if (options.segmentRetentionMonths > 0) {
    const cutoff = monthsBefore(now, options.segmentRetentionMonths);
    segments = deleteInBatches(
      sqlite,
      `DELETE FROM activity_segments WHERE id IN (
         SELECT id FROM activity_segments WHERE is_open = 0 AND end_at < ? LIMIT ?)`,
      cutoff,
    );
    const previous = segmentsPrunedBefore(database.db) ?? Number.NEGATIVE_INFINITY;
    if (cutoff > previous) setSetting(database.db, SEGMENTS_PRUNED_BEFORE_KEY, cutoff, now);
  }
  return { ipSeen, serverMinutely, segments };
}

/** Weekly maintenance: refresh planner statistics and shrink the WAL file. */
export function runMaintenance(sqlite: Database.Database): void {
  sqlite.pragma('optimize');
  sqlite.pragma('wal_checkpoint(TRUNCATE)');
}
