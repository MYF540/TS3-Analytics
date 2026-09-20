/**
 * Bookkeeping for the import CLIs (T8.2): one row per file, so an interrupted run continues at
 * the byte offset it stopped at and a second run does not write the same sessions twice.
 */
import type Database from 'better-sqlite3';
import type { ImportSource, ImportStatus } from '../schema.js';

export interface ImportRun {
  id: number;
  source: ImportSource;
  file: string;
  size: number;
  offset: number;
  status: ImportStatus;
  startedAt: number;
  updatedAt: number;
  linesRead: number;
  linesSkipped: number;
  sessionsWritten: number;
  problems: number;
  error: string | null;
}

export interface ImportCounters {
  offset: number;
  linesRead: number;
  linesSkipped: number;
  sessionsWritten: number;
  problems: number;
}

const COLUMNS = `id, source, file, size, offset, status, started_at AS startedAt,
  updated_at AS updatedAt, lines_read AS linesRead, lines_skipped AS linesSkipped,
  sessions_written AS sessionsWritten, problems, error`;

export function findImportRun(
  sqlite: Database.Database,
  source: ImportSource,
  file: string,
): ImportRun | undefined {
  return sqlite
    .prepare(`SELECT ${COLUMNS} FROM import_runs WHERE source = ? AND file = ?`)
    .get(source, file) as ImportRun | undefined;
}

export function listImportRuns(sqlite: Database.Database, source?: ImportSource): ImportRun[] {
  const where = source === undefined ? '' : 'WHERE source = ?';
  const args = source === undefined ? [] : [source];
  return sqlite
    .prepare(`SELECT ${COLUMNS} FROM import_runs ${where} ORDER BY file`)
    .all(...args) as ImportRun[];
}

/**
 * Marks a file as being imported and returns the row to continue from. A file whose size shrank
 * is treated as a different file: the old progress cannot be trusted, so it starts over.
 */
export function startImportRun(
  sqlite: Database.Database,
  run: { source: ImportSource; file: string; size: number },
  now: number,
): ImportRun {
  const existing = findImportRun(sqlite, run.source, run.file);
  if (existing && existing.size <= run.size && existing.status !== 'failed') {
    sqlite
      .prepare(`UPDATE import_runs SET size = ?, status = 'running', updated_at = ? WHERE id = ?`)
      .run(run.size, now, existing.id);
    return { ...existing, size: run.size, status: 'running', updatedAt: now };
  }
  if (existing) {
    sqlite
      .prepare(
        `UPDATE import_runs SET size = ?, offset = 0, status = 'running', started_at = ?,
           updated_at = ?, lines_read = 0, lines_skipped = 0, sessions_written = 0,
           problems = 0, error = NULL
         WHERE id = ?`,
      )
      .run(run.size, now, now, existing.id);
    return findImportRun(sqlite, run.source, run.file) as ImportRun;
  }
  sqlite
    .prepare(
      `INSERT INTO import_runs (source, file, size, offset, status, started_at, updated_at)
       VALUES (?, ?, ?, 0, 'running', ?, ?)`,
    )
    .run(run.source, run.file, run.size, now, now);
  return findImportRun(sqlite, run.source, run.file) as ImportRun;
}

/** Writes the progress of a running import. Counters are absolute, not increments. */
export function updateImportRun(
  sqlite: Database.Database,
  id: number,
  counters: ImportCounters,
  now: number,
): void {
  sqlite
    .prepare(
      `UPDATE import_runs SET offset = ?, lines_read = ?, lines_skipped = ?,
         sessions_written = ?, problems = ?, updated_at = ?
       WHERE id = ?`,
    )
    .run(
      counters.offset,
      counters.linesRead,
      counters.linesSkipped,
      counters.sessionsWritten,
      counters.problems,
      now,
      id,
    );
}

export function finishImportRun(sqlite: Database.Database, id: number, now: number): void {
  sqlite
    .prepare(`UPDATE import_runs SET status = 'done', updated_at = ? WHERE id = ?`)
    .run(now, id);
}

export function failImportRun(
  sqlite: Database.Database,
  id: number,
  error: string,
  now: number,
): void {
  sqlite
    .prepare(`UPDATE import_runs SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`)
    .run(error.slice(0, 1000), now, id);
}

/** A file that was read to the end before and has not grown since needs no second run. */
export function isImportDone(run: ImportRun | undefined, size: number): boolean {
  return run !== undefined && run.status === 'done' && run.size === size && run.offset >= size;
}
