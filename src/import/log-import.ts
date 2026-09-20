/**
 * Imports historical TeamSpeak server logs into the database (T8.6).
 *
 * One file is one transaction: either all of its sessions land or none of them do. An
 * interrupted run therefore leaves nothing half-written and simply reads the file again
 * (`import_runs`). Memory stays flat – lines are streamed and each finished session is written
 * right away, so only the connections that are open at that moment are held.
 *
 * Sessions are written as finished rows, **without** touching the aggregates: folding every
 * single session into `user_daily_stats` and `server_hourly` recomputes the same hours over and
 * over and turns a bulk import into hours of work. The aggregates are rebuilt once afterwards
 * (T8.7), which reads every session exactly once.
 */
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { AppDatabase } from '../db/client.js';
import {
  finishImportRun,
  isImportDone,
  findImportRun,
  startImportRun,
  updateImportRun,
  upsertIpSeen,
} from '../db/repositories/index.js';
import {
  SessionBuilder,
  type ImportedSession,
  type SessionCounters,
} from '../domain/import-sessions.js';
import { hashIp, normalizeIp } from '../domain/ip.js';
import { berlinOffset } from '../domain/time.js';
import { DbidResolver, type ClientMap } from './client-map.js';
import { parseLogLine, type LogZone } from './log-parser.js';
import { readLogFile } from './log-reader.js';

export interface ImportOptions {
  /** Time zone the log timestamps are in (docs/import-logs.md). */
  zone: LogZone;
  serverId: number;
  /** Longest session that is believed; `undefined` keeps every session. */
  maxDurationS?: number | undefined;
  /** Only sessions that start at or after this moment. */
  from?: number | undefined;
  /**
   * Only sessions that start before this moment – the switch to live tracking. Without it the
   * import would count the same evening twice.
   */
  to?: number | undefined;
  /** Nothing is written; the report is produced all the same. */
  dryRun: boolean;
  /** Keyed hashing of the addresses in the log; without it no IP data is stored at all. */
  ip?:
    | {
        hmacSecret: string;
        retentionDays: number;
        country?: ((ip: string) => string | null) | undefined;
      }
    | undefined;
  now: number;
  /** Called after each file, for the progress display. */
  onProgress?: ((progress: FileProgress) => void) | undefined;
}

export interface FileProgress {
  file: string;
  index: number;
  total: number;
  lines: number;
  sessions: number;
  skipped: boolean;
  seconds: number;
}

export interface ImportReport {
  files: number;
  /** Files that were already imported completely. */
  filesSkipped: number;
  lines: number;
  ignored: number;
  unparsed: number;
  truncated: number;
  /** Sessions the reconstruction produced. */
  sessions: number;
  /** Sessions inside the range – written, or in a dry run: what would be written. */
  sessionsWritten: number;
  /** Online time of those sessions, seconds. */
  secondsWritten: number;
  /** Sessions outside `from`/`to` – skipped, so nothing is counted twice. */
  outsideRange: number;
  usersResolved: number;
  placeholders: number;
  unresolvedIds: number;
  ipStored: number;
  ipTooOld: number;
  firstAt: number | undefined;
  lastAt: number | undefined;
  /** Connections per hour of the day in German time, to check the assumed time zone. */
  hours: number[];
  counters: SessionCounters;
  seconds: number;
}

interface IpSighting {
  dbid: number;
  at: number;
  ipHash: Buffer;
  subnetHash: Buffer;
  country: string | null;
}

/** Where a file's findings go; undefined during a dry run. */
interface Writer {
  session: (session: ImportedSession) => void;
  ip: (sighting: IpSighting) => void;
}

function emptyCounters(): SessionCounters {
  return {
    connects: 0,
    disconnects: 0,
    sessions: 0,
    doubleConnects: 0,
    strayDisconnects: 0,
    capped: 0,
    closedByServer: 0,
    closedAtEnd: 0,
    backwardsInTime: 0,
    empty: 0,
  };
}

function emptyReport(): ImportReport {
  return {
    files: 0,
    filesSkipped: 0,
    lines: 0,
    ignored: 0,
    unparsed: 0,
    truncated: 0,
    sessions: 0,
    sessionsWritten: 0,
    secondsWritten: 0,
    outsideRange: 0,
    usersResolved: 0,
    placeholders: 0,
    unresolvedIds: 0,
    ipStored: 0,
    ipTooOld: 0,
    firstAt: undefined,
    lastAt: undefined,
    hours: new Array<number>(24).fill(0),
    counters: emptyCounters(),
    seconds: 0,
  };
}

function addCounters(into: SessionCounters, from: SessionCounters): void {
  for (const key of Object.keys(into) as (keyof SessionCounters)[]) into[key] += from[key];
}

/** A session outside the range would double count time the live tracking already has. */
function inRange(at: number, options: ImportOptions): boolean {
  if (options.from !== undefined && at < options.from) return false;
  if (options.to !== undefined && at >= options.to) return false;
  return true;
}

interface FileOutcome {
  lines: number;
  ignored: number;
  unparsed: number;
  truncated: number;
  offset: number;
  sessions: number;
  written: number;
  secondsWritten: number;
  outsideRange: number;
  ipStored: number;
  ipTooOld: number;
  hours: number[];
  counters: SessionCounters;
  firstAt: number | undefined;
  lastAt: number | undefined;
}

/**
 * Reads one file and hands what it contains to the writer. The caller has opened a transaction
 * (or is doing a dry run, where `write` is undefined).
 */
async function processFile(
  path: string,
  start: number,
  options: ImportOptions,
  write: Writer | undefined,
  onOffset: (progress: { offset: number; lines: number; ignored: number }) => void,
): Promise<FileOutcome> {
  const builder = new SessionBuilder({ maxDurationS: options.maxDurationS });
  const out: FileOutcome = {
    lines: 0,
    ignored: 0,
    unparsed: 0,
    truncated: 0,
    offset: start,
    sessions: 0,
    written: 0,
    secondsWritten: 0,
    outsideRange: 0,
    ipStored: 0,
    ipTooOld: 0,
    hours: new Array<number>(24).fill(0),
    counters: builder.counters,
    firstAt: undefined,
    lastAt: undefined,
  };
  const ipCutoff = options.ip === undefined ? 0 : options.now - options.ip.retentionDays * 86_400;
  let lastAt = 0;

  const take = (session: ImportedSession): void => {
    out.sessions++;
    if (!inRange(session.joinAt, options)) {
      out.outsideRange++;
      return;
    }
    out.written++;
    out.secondsWritten += session.leaveAt - session.joinAt;
    write?.session(session);
  };

  for await (const { line, offset, truncated } of readLogFile(path, start)) {
    out.lines++;
    out.offset = offset;
    if (truncated) out.truncated++;
    if (out.lines % 500_000 === 0) onOffset({ offset, lines: out.lines, ignored: out.ignored });

    const event = parseLogLine(line, { zone: options.zone, serverId: options.serverId });
    if (event.kind === 'ignored' || event.kind === 'group') {
      // Server group changes are watched live (T5.5); the old ones add nothing.
      out.ignored++;
      continue;
    }
    if (event.kind === 'unparsed') {
      out.unparsed++;
      continue;
    }
    lastAt = Math.max(lastAt, event.at);
    out.firstAt ??= event.at;
    out.lastAt = lastAt;

    if (event.kind === 'connect') {
      const localHour = new Date((event.at + berlinOffset(event.at)) * 1000).getUTCHours();
      out.hours[localHour] = (out.hours[localHour] ?? 0) + 1;
      if (options.ip && inRange(event.at, options)) {
        if (event.at < ipCutoff) {
          out.ipTooOld++;
        } else {
          const ip = normalizeIp(event.ip.replace(/^\[|\]$/g, ''));
          if (ip) {
            const { ipHash, subnetHash } = hashIp(ip, options.ip.hmacSecret);
            out.ipStored++;
            write?.ip({
              dbid: event.dbid,
              at: event.at,
              ipHash,
              subnetHash,
              country: options.ip.country?.(ip.address) ?? null,
            });
          }
        }
      }
    }
    for (const session of builder.push(event)) take(session);
  }
  for (const session of builder.endOfLogs(lastAt)) take(session);
  return out;
}

/**
 * Imports the given files in the order they are passed (oldest first, see `orderLogFiles`).
 * `clients` maps the database ids of the log to UIDs (T8.3).
 */
export async function importLogs(
  database: AppDatabase,
  files: readonly string[],
  clients: ClientMap,
  options: ImportOptions,
): Promise<ImportReport> {
  const report = emptyReport();
  const resolver = new DbidResolver(database.db, clients);
  const insert = database.sqlite.prepare(
    `INSERT INTO sessions (user_id, join_at, leave_at, duration, source)
     VALUES (?, ?, ?, ?, 'import')`,
  );
  const startedAll = Date.now();

  const write: Writer | undefined = options.dryRun
    ? undefined
    : {
        session: (session) => {
          const userId = resolver.resolve(session.dbid, session.joinAt, session.nick);
          insert.run(userId, session.joinAt, session.leaveAt, session.leaveAt - session.joinAt);
        },
        ip: (sighting) => {
          upsertIpSeen(database.db, {
            userId: resolver.resolve(sighting.dbid, sighting.at),
            ipHash: sighting.ipHash,
            subnetHash: sighting.subnetHash,
            country: sighting.country,
            seenAt: sighting.at,
          });
        },
      };

  for (const [index, path] of files.entries()) {
    const startedFile = Date.now();
    const name = basename(path);
    const size = statSync(path).size;
    const previous = options.dryRun ? undefined : findImportRun(database.sqlite, 'logs', name);
    if (!options.dryRun && isImportDone(previous, size)) {
      report.filesSkipped++;
      options.onProgress?.({
        file: name,
        index,
        total: files.length,
        lines: 0,
        sessions: 0,
        skipped: true,
        seconds: 0,
      });
      continue;
    }

    const run = options.dryRun
      ? undefined
      : startImportRun(database.sqlite, { source: 'logs', file: name, size }, options.now);

    // Everything one file contributes goes into one transaction. Reading is asynchronous, so
    // the transaction is handled by hand – sqlite.transaction() only wraps synchronous work.
    if (run) database.sqlite.exec('BEGIN IMMEDIATE');
    let outcome: FileOutcome;
    try {
      outcome = await processFile(path, run?.offset ?? 0, options, write, (progress) => {
        if (!run) return;
        updateImportRun(
          database.sqlite,
          run.id,
          {
            offset: Math.min(progress.offset, size),
            linesRead: progress.lines,
            linesSkipped: progress.ignored,
            sessionsWritten: 0,
            problems: 0,
          },
          options.now,
        );
      });
      if (run) {
        updateImportRun(
          database.sqlite,
          run.id,
          {
            offset: Math.min(outcome.offset, size),
            linesRead: outcome.lines,
            linesSkipped: outcome.ignored,
            sessionsWritten: outcome.written,
            problems: outcome.unparsed + outcome.truncated,
          },
          options.now,
        );
        finishImportRun(database.sqlite, run.id, options.now);
        database.sqlite.exec('COMMIT');
      }
    } catch (error) {
      if (run) database.sqlite.exec('ROLLBACK');
      throw error;
    }

    report.files++;
    report.lines += outcome.lines;
    report.ignored += outcome.ignored;
    report.unparsed += outcome.unparsed;
    report.truncated += outcome.truncated;
    report.sessions += outcome.sessions;
    report.sessionsWritten += outcome.written;
    report.secondsWritten += outcome.secondsWritten;
    report.outsideRange += outcome.outsideRange;
    report.ipStored += outcome.ipStored;
    report.ipTooOld += outcome.ipTooOld;
    addCounters(report.counters, outcome.counters);
    for (const [hour, count] of outcome.hours.entries()) {
      report.hours[hour] = (report.hours[hour] ?? 0) + count;
    }
    if (outcome.firstAt !== undefined) {
      report.firstAt = Math.min(report.firstAt ?? outcome.firstAt, outcome.firstAt);
    }
    if (outcome.lastAt !== undefined) {
      report.lastAt = Math.max(report.lastAt ?? outcome.lastAt, outcome.lastAt);
    }
    options.onProgress?.({
      file: name,
      index,
      total: files.length,
      lines: outcome.lines,
      sessions: outcome.written,
      skipped: false,
      seconds: (Date.now() - startedFile) / 1000,
    });
  }

  report.usersResolved = resolver.counters.resolved;
  report.placeholders = resolver.counters.placeholders;
  report.unresolvedIds = resolver.unresolved.size;
  report.seconds = (Date.now() - startedAll) / 1000;
  return report;
}
