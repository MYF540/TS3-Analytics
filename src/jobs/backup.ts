import { mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Database from 'better-sqlite3';
import type { AppDatabase } from '../db/client.js';

const PREFIX = 'ts3-analytics-';
const NAME = /^ts3-analytics-\d{8}-\d{6}\.sqlite$/;

export interface BackupOptions {
  dir: string;
  /** Number of backups kept (the newest). */
  keep: number;
  /** UTC seconds; part of the file name. */
  now: number;
}

export interface BackupResult {
  file: string;
  bytes: number;
  /** Older backups deleted by the rotation. */
  removed: string[];
}

function stamp(now: number): string {
  const iso = new Date(now * 1000).toISOString(); // 2026-09-20T01:02:03.000Z
  return `${iso.slice(0, 10).replaceAll('-', '')}-${iso.slice(11, 19).replaceAll(':', '')}`;
}

/** Newest first. */
export function listBackups(dir: string): string[] {
  try {
    return readdirSync(dir)
      .filter((name) => NAME.test(name))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * Online backup (T7.1) with SQLite's backup API: consistent while the watcher keeps writing. The
 * copy is written as `.partial`, checked with `quick_check` and only then renamed, so a broken or
 * half-written file never counts as a backup. Keeps the newest `keep` backups.
 */
export async function runBackup(
  database: AppDatabase,
  options: BackupOptions,
): Promise<BackupResult> {
  const dir = resolve(options.dir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${PREFIX}${stamp(options.now)}.sqlite`);
  const partial = `${file}.partial`;
  rmSync(partial, { force: true });

  await database.sqlite.backup(partial);
  const copy = new Database(partial, { fileMustExist: true });
  let check: unknown;
  try {
    // The copy inherits WAL mode; a backup should be one self-contained file.
    copy.pragma('journal_mode = DELETE');
    check = copy.pragma('quick_check', { simple: true });
  } finally {
    copy.close();
  }
  for (const suffix of ['-wal', '-shm']) rmSync(`${partial}${suffix}`, { force: true });
  if (check !== 'ok') {
    rmSync(partial, { force: true });
    throw new Error(`Backup failed its integrity check: ${String(check)}`);
  }
  renameSync(partial, file);

  const removed = listBackups(dir).slice(options.keep);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  return { file, bytes: statSync(file).size, removed };
}
