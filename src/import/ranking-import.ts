/**
 * Takes the ranking times of the old system over (T8.9). Structure and findings of the source
 * are written down in docs/import-legacy-ranking.md.
 *
 * The values are seconds of pure online time per UID, kept in the SinusBot key-value table
 * `scriptdata`. They cover everything up to the switch (`legacy.cutoff`); from there on the rank
 * engine counts the time this application records itself, so nothing is counted twice.
 */
import Database from 'better-sqlite3';
import type { AppDatabase } from '../db/client.js';
import { setSetting, upsertUser } from '../db/repositories/index.js';
import { isClientUid } from './client-map.js';
import { LEGACY_CUTOFF_KEY } from '../ranks/planner.js';

/** Both script names the data was stored under; the one with the space is the older one. */
export const SCRIPT_NAMES = ['Tunakills_Rankingsystem', 'Tunakills Rankingsystem'] as const;
const TIME_PREFIX = 'timetrak';

export interface LegacyEntry {
  uid: string;
  /** Seconds, the larger of both data sets. */
  seconds: number;
  /** Seconds in the current data set, 0 when the UID only exists in the older one. */
  current: number;
  /** Seconds in the older data set. */
  previous: number;
  /** Server group of the old ladder this time corresponds to, null below the first step. */
  groupId: number | null;
}

export interface LegacyLadderStep {
  /** Minutes in the old configuration. */
  minutes: number;
  groupId: number;
}

export interface LegacyData {
  entries: LegacyEntry[];
  ladder: LegacyLadderStep[];
  /** UIDs that only the older data set knows. */
  onlyPrevious: number;
  /** UIDs whose older value was larger – they lost time when the script was renamed. */
  previousLarger: number;
}

export class LegacyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LegacyImportError';
  }
}

/** Server groups and thresholds of the old ladder, out of the SinusBot instance configuration. */
function readLadder(sqlite: Database.Database): LegacyLadderStep[] {
  const rows = sqlite.prepare(`SELECT config FROM instances`).all() as { config: string }[];
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.config);
    } catch {
      continue;
    }
    const settings = (parsed as { scriptSettings?: Record<string, unknown> }).scriptSettings ?? {};
    for (const name of SCRIPT_NAMES) {
      const entry = settings[name] as
        | {
            settings?: {
              server_group_to_set?: { time_required?: number; server_group?: number }[];
            };
          }
        | undefined;
      const steps = entry?.settings?.server_group_to_set;
      if (!steps || steps.length === 0) continue;
      return steps
        .filter(
          (step): step is { time_required: number; server_group: number } =>
            typeof step.time_required === 'number' && typeof step.server_group === 'number',
        )
        .map((step) => ({ minutes: step.time_required, groupId: step.server_group }))
        .sort((a, b) => a.minutes - b.minutes);
    }
  }
  return [];
}

/** The step a time falls into; the old script compared `time_required * 60 < seconds`. */
export function legacyGroupFor(
  seconds: number,
  ladder: readonly LegacyLadderStep[],
): number | null {
  let group: number | null = null;
  for (const step of ladder) {
    if (step.minutes * 60 < seconds) group = step.groupId;
  }
  return group;
}

/** Reads a copy of the SinusBot database. Nothing is written, the file is opened read-only. */
export function readLegacyRanking(path: string): LegacyData {
  let sqlite: Database.Database;
  try {
    sqlite = new Database(path, { readonly: true, fileMustExist: true });
  } catch (error) {
    throw new LegacyImportError(`${path} ist nicht lesbar: ${String(error)}`);
  }
  try {
    const hasTable = sqlite
      .prepare(`SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = 'scriptdata'`)
      .pluck()
      .get() as number;
    if (hasTable === 0) {
      throw new LegacyImportError(
        `${path} enthält keine Tabelle "scriptdata" – ist das die SinusBot-Datenbank?`,
      );
    }
    const read = (script: string): Map<string, number> => {
      const rows = sqlite
        .prepare(`SELECT keyname, data FROM scriptdata WHERE uuid = ?`)
        .all(script) as { keyname: string; data: unknown }[];
      const times = new Map<string, number>();
      for (const row of rows) {
        if (!row.keyname.startsWith(TIME_PREFIX)) continue;
        const uid = row.keyname.slice(TIME_PREFIX.length);
        if (!isClientUid(uid)) continue;
        const seconds = Number(String(row.data));
        if (!Number.isFinite(seconds) || seconds < 0) continue;
        times.set(uid, Math.floor(seconds));
      }
      return times;
    };

    const current = read(SCRIPT_NAMES[0]);
    const previous = read(SCRIPT_NAMES[1]);
    const ladder = readLadder(sqlite);

    let onlyPrevious = 0;
    let previousLarger = 0;
    const entries: LegacyEntry[] = [];
    for (const uid of new Set([...current.keys(), ...previous.keys()])) {
      const now = current.get(uid) ?? 0;
      const before = previous.get(uid) ?? 0;
      if (!current.has(uid)) onlyPrevious++;
      else if (before > now) previousLarger++;
      const seconds = Math.max(now, before);
      entries.push({
        uid,
        seconds,
        current: now,
        previous: before,
        groupId: legacyGroupFor(seconds, ladder),
      });
    }
    entries.sort((a, b) => b.seconds - a.seconds || a.uid.localeCompare(b.uid));
    return { entries, ladder, onlyPrevious, previousLarger };
  } finally {
    sqlite.close();
  }
}

export interface RankingImportOptions {
  /** Moment of the switch: before it the old times count, after it the live tracking. */
  cutoff: number;
  dryRun: boolean;
  /** Entries with less time than this are skipped (0 keeps everything). */
  minSeconds?: number | undefined;
}

export interface RankingImportReport {
  entries: number;
  skipped: number;
  /** Players that already existed here. */
  known: number;
  /** Players created for this time, they have not connected since the switch. */
  created: number;
  secondsTotal: number;
  /** Players whose stored value was already the same – a second run changes nothing. */
  unchanged: number;
  cutoff: number;
}

/**
 * Writes `users.legacy_seconds` and `users.legacy_rank` per UID and stores the cutoff. Running it
 * twice is harmless: the values are set, not added.
 */
export function importRanking(
  database: AppDatabase,
  data: LegacyData,
  options: RankingImportOptions,
): RankingImportReport {
  const report: RankingImportReport = {
    entries: data.entries.length,
    skipped: 0,
    known: 0,
    created: 0,
    secondsTotal: 0,
    unchanged: 0,
    cutoff: options.cutoff,
  };
  const min = options.minSeconds ?? 0;
  const find = database.sqlite.prepare(
    `SELECT id, legacy_seconds AS seconds, legacy_rank AS rank FROM users WHERE uid = ?`,
  );
  const update = database.sqlite.prepare(
    `UPDATE users SET legacy_seconds = ?, legacy_rank = ? WHERE id = ?`,
  );

  const write = () => {
    for (const entry of data.entries) {
      if (entry.seconds < min) {
        report.skipped++;
        continue;
      }
      report.secondsTotal += entry.seconds;
      const existing = find.get(entry.uid) as
        { id: number; seconds: number; rank: number | null } | undefined;
      if (existing) {
        report.known++;
        if (existing.seconds === entry.seconds && existing.rank === entry.groupId) {
          report.unchanged++;
          continue;
        }
        if (!options.dryRun) update.run(entry.seconds, entry.groupId, existing.id);
        continue;
      }
      report.created++;
      if (options.dryRun) continue;
      // The player has not been seen by this application yet; the switch is the earliest moment
      // we can honestly claim, and `upsertUser` keeps the earlier one if they show up later.
      const id = upsertUser(database.db, { uid: entry.uid, seenAt: options.cutoff });
      update.run(entry.seconds, entry.groupId, id);
    }
    if (!options.dryRun) setSetting(database.db, LEGACY_CUTOFF_KEY, options.cutoff, options.cutoff);
  };

  if (options.dryRun) write();
  else database.sqlite.transaction(write)();
  return report;
}
