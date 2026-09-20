/**
 * Imports historical TeamSpeak server logs (T8.6).
 *
 *   pnpm import:logs <ordner> [--dry-run] [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *                    [--clients <ts3server.sqlitedb>] [--server 1] [--zone berlin|utc]
 *                    [--max-session <stunden>] [--no-rebuild] [--yes]
 *
 * Stop the service first, or import into a copy of the database and swap it afterwards: the
 * import writes many sessions at once and would fight the watcher over the same rows.
 *
 * Only times **before** the switch to live tracking are imported (`--to`, by default the first
 * live session). Otherwise the same evening would be counted twice.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfigOrExit } from '../config/config.js';
import { PrunedRangeError, rebuildAggregates } from '../db/aggregates.js';
import { openDatabase, runMigrations } from '../db/client.js';
import { berlinDay, berlinDayStart, nextDay, parseDay } from '../domain/time.js';
import { openCountryLookup } from '../geoip/country-lookup.js';
import { createLogger } from '../logging/logger.js';
import { readClientMap, type ClientMap } from '../import/client-map.js';
import { importLogs, type ImportReport } from '../import/log-import.js';
import { LOG_ZONES, orderLogFiles, type LogZone } from '../import/log-parser.js';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseDayOption(name: string, value: string | undefined, endOfDay = false): number {
  const day = parseDay(value ?? '');
  if (day === undefined) {
    fail(`--${name} muss ein Datum der Form JJJJ-MM-TT sein, war "${String(value)}".`);
  }
  return berlinDayStart(endOfDay ? nextDay(day) : day);
}

/** Number with thousands separators, like the rest of the German output. */
const n = (value: number) => value.toLocaleString('de-DE');
const hours = (seconds: number) => `${n(Math.round(seconds / 3600))} h`;

function printReport(report: ImportReport, dryRun: boolean): void {
  const c = report.counters;
  console.log('');
  console.log(dryRun ? '--- Probelauf, nichts geschrieben ---' : '--- Import abgeschlossen ---');
  console.log(
    `Dateien:               ${n(report.files)} gelesen, ${n(report.filesSkipped)} übersprungen`,
  );
  console.log(`Zeilen:                ${n(report.lines)}`);
  console.log(`  übersprungen:        ${n(report.ignored)} (Query-Clients und anderes Rauschen)`);
  console.log(`  unbekannt:           ${n(report.unparsed)}`);
  console.log(`  abgeschnitten:       ${n(report.truncated)}`);
  console.log(`Verbindungen:          ${n(c.connects)}, Trennungen ${n(c.disconnects)}`);
  console.log(`Sitzungen:             ${n(report.sessions)}`);
  console.log(
    `  ${dryRun ? 'im Zeitraum:       ' : 'geschrieben:       '}  ${n(report.sessionsWritten)}`,
  );
  console.log(`  Online-Zeit:         ${hours(report.secondsWritten)}`);
  console.log(`  außerhalb Zeitraum:  ${n(report.outsideRange)}`);
  console.log(`  doppelt verbunden:   ${n(c.doubleConnects)}`);
  console.log(`  ohne Verbindung:     ${n(c.strayDisconnects)}`);
  console.log(`  gekappt:             ${n(c.capped)}`);
  console.log(`  ohne Dauer:          ${n(c.empty)}`);
  console.log(
    `  vom Server beendet:  ${n(c.closedByServer)}, am Ende der Logs ${n(c.closedAtEnd)}`,
  );
  console.log(`  Zeit rückwärts:      ${n(c.backwardsInTime)}`);
  console.log(
    `Spieler:               ${n(report.usersResolved)} zugeordnet, ${n(report.placeholders)} Platzhalter (${n(report.unresolvedIds)} unbekannte IDs)`,
  );
  console.log(
    `IP-Prüfsummen:         ${n(report.ipStored)} gespeichert, ${n(report.ipTooOld)} zu alt`,
  );
  if (report.firstAt !== undefined && report.lastAt !== undefined) {
    const day = (t: number) => new Date(t * 1000).toISOString().slice(0, 10);
    console.log(`Zeitraum:              ${day(report.firstAt)} bis ${day(report.lastAt)}`);
  }
  console.log(`Dauer:                 ${report.seconds.toFixed(1)} s`);

  const max = Math.max(...report.hours, 1);
  console.log('');
  console.log('Verbindungen je Stunde (deutsche Zeit) – prüfe, ob der Abend das Maximum ist:');
  for (const [hour, count] of report.hours.entries()) {
    const bar = '#'.repeat(Math.round((count / max) * 40));
    console.log(`  ${String(hour).padStart(2, '0')} ${bar.padEnd(40)} ${n(count)}`);
  }
  if (report.unparsed > 0) {
    console.log('');
    console.log(
      'Unbekannte Zeilen sind normal, solange es wenige sind – siehe docs/import-logs.md.',
    );
  }
}

/** The moment live tracking started; importing past it would count the same time twice. */
function firstLiveSession(sqlite: ReturnType<typeof openDatabase>['sqlite']): number | undefined {
  const at = sqlite
    .prepare(`SELECT min(join_at) FROM sessions WHERE source = 'live'`)
    .pluck()
    .get() as number | null;
  return at ?? undefined;
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [j/N] `);
    return answer.trim().toLowerCase().startsWith('j');
  } finally {
    rl.close();
  }
}

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      from: { type: 'string' },
      to: { type: 'string' },
      clients: { type: 'string' },
      server: { type: 'string' },
      zone: { type: 'string', default: 'berlin' },
      'max-session': { type: 'string' },
      'no-rebuild': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const dir = positionals[0];
  if (dir === undefined) {
    fail('Verwendung: pnpm import:logs <ordner> [--dry-run] [--from JJJJ-MM-TT] [--to JJJJ-MM-TT]');
  }
  if (!existsSync(dir) || !statSync(dir).isDirectory()) fail(`${dir} ist kein Ordner.`);
  if (!(LOG_ZONES as readonly string[]).includes(values.zone)) {
    fail(`--zone muss ${LOG_ZONES.join(' oder ')} sein.`);
  }
  const zone = values.zone as LogZone;

  const config = loadConfigOrExit();
  const serverId = values.server === undefined ? config.ts3.serverId : Number(values.server);
  if (!Number.isInteger(serverId) || serverId < 0) fail('--server muss eine Zahl sein.');

  const files = orderLogFiles(readdirSync(dir), { zone, serverId });
  if (files.length === 0) {
    fail(`In ${dir} liegen keine Logdateien des virtuellen Servers ${String(serverId)}.`);
  }

  let clients: ClientMap = new Map();
  if (values.clients !== undefined) {
    clients = readClientMap(values.clients, { serverId });
    console.log(`Server-Datenbank: ${n(clients.size)} Accounts für Server ${String(serverId)}.`);
  } else {
    console.log(
      'Ohne --clients <ts3server.sqlitedb> bekommt jeder Spieler einen Platzhalter statt seiner UID.',
    );
  }

  const logger = createLogger(config.logging);
  const database = openDatabase(config.database);
  try {
    runMigrations(database);

    const live = firstLiveSession(database.sqlite);
    const to = values.to !== undefined ? parseDayOption('to', values.to, true) : live;
    if (to !== undefined) {
      console.log(`Es werden nur Sitzungen vor ${new Date(to * 1000).toISOString()} importiert.`);
    }
    const from = values.from === undefined ? undefined : parseDayOption('from', values.from);
    if (from !== undefined && to !== undefined && from >= to) fail('--from liegt nach --to.');

    const maxSession =
      values['max-session'] === undefined ? undefined : Number(values['max-session']) * 3600;
    if (maxSession !== undefined && (!Number.isFinite(maxSession) || maxSession <= 0)) {
      fail('--max-session muss eine Zahl in Stunden sein.');
    }

    console.log(
      `${n(files.length)} Dateien, Zeitzone ${zone === 'berlin' ? 'deutsche Zeit' : 'UTC'}` +
        `${maxSession === undefined ? ', keine Höchstdauer' : `, Höchstdauer ${String(maxSession / 3600)} h`}.`,
    );
    if (!values['dry-run'] && !values.yes) {
      console.log('Vorher sichern: pnpm backup. Der Dienst sollte gestoppt sein.');
      if (!(await confirm('Import jetzt starten?'))) {
        console.log('Abgebrochen.');
        return;
      }
    }

    const countries = await openCountryLookup(config.paths.geoipDb, logger);
    if (!values['dry-run']) {
      // Bulk mode: the import writes millions of rows, and a crash in the middle costs nothing –
      // a file only counts as imported once its transaction is committed (import_runs).
      database.sqlite.pragma('synchronous = OFF');
    }
    const report = await importLogs(
      database,
      files.map((file) => join(dir, file.name)),
      clients,
      {
        zone,
        serverId,
        maxDurationS: maxSession,
        from,
        to,
        dryRun: values['dry-run'],
        ip: {
          hmacSecret: config.security.hmacSecret,
          retentionDays: config.retention.ipDays,
          country: (ip) => countries.country(ip) ?? null,
        },
        now: Math.floor(Date.now() / 1000),
        onProgress: (progress) => {
          const done = progress.index + 1;
          const prefix = `[${String(done)}/${String(progress.total)}]`;
          if (progress.skipped) {
            console.log(`${prefix} ${progress.file}: schon importiert`);
            return;
          }
          const speed =
            progress.seconds > 0 ? Math.round(progress.lines / progress.seconds) : progress.lines;
          console.log(
            `${prefix} ${progress.file}: ${n(progress.lines)} Zeilen, ` +
              `${n(progress.sessions)} Sitzungen, ${progress.seconds.toFixed(1)} s (${n(speed)} Zeilen/s)`,
          );
        },
      },
    );
    if (!values['dry-run']) {
      database.sqlite.pragma('synchronous = NORMAL');
      if (report.sessionsWritten > 0) {
        console.log('Statistiken der Datenbank werden aktualisiert …');
        database.sqlite.exec('ANALYZE');
      }
    }
    printReport(report, values['dry-run']);

    // The import writes sessions only; the aggregates are rebuilt once at the end (T8.7).
    if (!values['dry-run'] && report.sessionsWritten > 0 && report.firstAt !== undefined) {
      if (values['no-rebuild']) {
        console.log('');
        console.log('Tageswerte noch nicht berechnet – nachholen mit: pnpm stats:rebuild');
      } else {
        console.log('');
        console.log('Tageswerte und Stunden werden neu berechnet …');
        const started = Date.now();
        try {
          const result = rebuildAggregates(database, { fromDay: berlinDay(report.firstAt) });
          console.log(
            `Fertig: ${n(result.users)} Spieler, ${n(result.dailyRows)} Tageszeilen, ` +
              `${n(result.hours)} Stunden in ${((Date.now() - started) / 1000).toFixed(1)} s.`,
          );
        } catch (error) {
          if (!(error instanceof PrunedRangeError)) throw error;
          console.log(
            'Für diesen Zeitraum wurden Aktivitätsdaten bereits gelöscht (Aufbewahrung).',
          );
          console.log('Deshalb bitte selbst entscheiden: pnpm stats:rebuild --from … [--force]');
        }
      }
    }
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error('Import fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
