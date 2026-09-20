/**
 * Takes the ranking times of the old system over (T8.9).
 *
 *   pnpm import:ranking <sinusbot.sqlite> [--dry-run] [--cutoff JJJJ-MM-TT]
 *                       [--map <datei.json>] [--min-minutes 15] [--yes]
 *
 * The file is a **copy** of the SinusBot database and is only read. Written are
 * `users.legacy_seconds`, `users.legacy_rank` and the cutoff: from that moment on the rank
 * engine counts the time this application records itself, before it the old value counts –
 * never both (AGENTS.md rule 12).
 */
import { existsSync, readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { loadConfigOrExit } from '../config/config.js';
import { openDatabase, runMigrations } from '../db/client.js';
import { listRanks } from '../db/repositories/index.js';
import { decideRank } from '../domain/ranks.js';
import { berlinDayStart, parseDay } from '../domain/time.js';
import {
  importRanking,
  readLegacyRanking,
  type LegacyData,
  type RankingImportReport,
} from '../import/ranking-import.js';

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const n = (value: number) => value.toLocaleString('de-DE');
const hours = (seconds: number) => `${n(Math.round(seconds / 3600))} h`;

/** Threshold of the old ladder in a form a human reads without converting. */
function span(minutes: number): string {
  if (minutes < 60) return `${n(minutes)} Min.`;
  if (minutes < 1440) return `${n(Math.round(minutes / 60))} Std.`;
  const days = Math.round(minutes / 1440);
  return `${n(days)} ${days === 1 ? 'Tag' : 'Tage'}`;
}

/** Maps a server group of the old ladder to one of our ranks, from a small JSON file. */
function readMap(path: string): Map<number, number> {
  if (!existsSync(path)) fail(`${path} gibt es nicht.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(`${path} ist kein lesbares JSON: ${String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    fail(`${path} muss ein Objekt sein, z. B. {"135": 1, "59": 2} (alte Gruppe: unser Rang).`);
  }
  const map = new Map<number, number>();
  for (const [key, value] of Object.entries(parsed)) {
    if (!Number.isInteger(Number(key)) || !Number.isInteger(value)) {
      fail(`${path}: "${key}" muss eine Gruppen-ID und der Wert eine Rang-ID sein.`);
    }
    map.set(Number(key), value as number);
  }
  return map;
}

function printSource(data: LegacyData): void {
  console.log(`Einträge:              ${n(data.entries.length)}`);
  console.log(
    `Summe:                 ${hours(data.entries.reduce((sum, e) => sum + e.seconds, 0))}`,
  );
  console.log(`Nur im alten Bestand:  ${n(data.onlyPrevious)}`);
  console.log(`Alter Wert größer:     ${n(data.previousLarger)} (es zählt der größere)`);
  if (data.ladder.length === 0) {
    console.log('Alte Rangleiter:       nicht gefunden – `legacy_rank` bleibt leer.');
    return;
  }
  console.log('Alte Rangleiter:');
  for (const step of data.ladder) {
    const count = data.entries.filter((e) => e.groupId === step.groupId).length;
    console.log(
      `  ab ${span(step.minutes).padStart(9)} → Gruppe ${String(step.groupId).padStart(4)}: ` +
        `${n(count)} Spieler`,
    );
  }
  const below = data.entries.filter((e) => e.groupId === null).length;
  console.log(`  unter der ersten Stufe: ${n(below)} Spieler`);
}

/**
 * What our ladder would make of the taken-over times. Only the times matter here – live time
 * after the cutoff does not exist yet at that moment.
 */
function printComparison(
  database: ReturnType<typeof openDatabase>,
  data: LegacyData,
  map: Map<number, number> | undefined,
): void {
  const ranks = listRanks(database.sqlite);
  if (ranks.length === 0) {
    console.log('');
    console.log('Es ist noch keine Rangleiter eingerichtet – Vergleich entfällt.');
    return;
  }
  const ladder = ranks.map((r) => ({
    id: r.id,
    requiredS: r.requiredS,
    serverGroupId: r.serverGroupId,
  }));
  const names = new Map(ranks.map((r) => [r.id, r.name]));
  const counts = new Map<string, number>();
  let same = 0;
  let higher = 0;
  let lower = 0;
  for (const entry of data.entries) {
    const decision = decideRank(ladder, {
      rankingS: entry.seconds,
      override: undefined,
      inExcludedGroup: false,
    });
    const mine = decision.kind === 'rank' ? decision.rankId : null;
    const label = mine === null ? 'kein Rang' : (names.get(mine) ?? String(mine));
    counts.set(label, (counts.get(label) ?? 0) + 1);
    if (!map || entry.groupId === null) continue;
    const expected = map.get(entry.groupId);
    if (expected === undefined) continue;
    const order = (id: number | null) => (id === null ? -1 : ladder.findIndex((r) => r.id === id));
    const diff = order(mine) - order(expected);
    if (diff === 0) same++;
    else if (diff > 0) higher++;
    else lower++;
  }
  console.log('');
  console.log('Mit unserer Rangleiter ergäbe sich daraus:');
  for (const rank of ranks) {
    console.log(`  ${rank.name.padEnd(24)} ${n(counts.get(rank.name) ?? 0)}`);
  }
  console.log(`  ${'kein Rang'.padEnd(24)} ${n(counts.get('kein Rang') ?? 0)}`);
  if (map) {
    console.log('');
    console.log(
      `Vergleich mit dem alten Rang: gleich ${n(same)}, höher ${n(higher)}, niedriger ${n(lower)}.`,
    );
    if (lower > 0) {
      console.log('Diese Spieler würden beim ersten Rang-Lauf absteigen. Vor dem Abschalten des');
      console.log('Probelaufs entweder die Schwellen anpassen oder die Ränge einfrieren (T6.4).');
    }
  } else {
    console.log('');
    console.log('Mit --map <datei.json> wird zusätzlich geprüft, wer dabei absteigen würde.');
  }
}

function printReport(report: RankingImportReport, dryRun: boolean): void {
  console.log('');
  console.log(dryRun ? '--- Probelauf, nichts geschrieben ---' : '--- Import abgeschlossen ---');
  console.log(`Übernommen:            ${n(report.entries - report.skipped)} Spieler`);
  console.log(`  davon bekannt:       ${n(report.known)}`);
  console.log(`  neu angelegt:        ${n(report.created)}`);
  console.log(`  unverändert:         ${n(report.unchanged)}`);
  console.log(`Übersprungen:          ${n(report.skipped)} (unter der Mindestzeit)`);
  console.log(`Zeit gesamt:           ${hours(report.secondsTotal)}`);
  console.log(`Stichtag:              ${new Date(report.cutoff * 1000).toISOString()}`);
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
      cutoff: { type: 'string' },
      map: { type: 'string' },
      'min-minutes': { type: 'string' },
      yes: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const path = positionals[0];
  if (path === undefined) fail('Verwendung: pnpm import:ranking <sinusbot.sqlite> [--dry-run]');
  if (!existsSync(path)) fail(`${path} gibt es nicht.`);

  let cutoff = Math.floor(Date.now() / 1000);
  if (values.cutoff !== undefined) {
    const day = parseDay(values.cutoff);
    if (day === undefined) fail('--cutoff muss ein Datum der Form JJJJ-MM-TT sein.');
    cutoff = berlinDayStart(day);
  }
  const minMinutes = values['min-minutes'] === undefined ? 0 : Number(values['min-minutes']);
  if (!Number.isFinite(minMinutes) || minMinutes < 0) fail('--min-minutes muss eine Zahl sein.');
  const map = values.map === undefined ? undefined : readMap(values.map);

  const data = readLegacyRanking(path);
  console.log('');
  printSource(data);

  const config = loadConfigOrExit();
  const database = openDatabase(config.database);
  try {
    runMigrations(database);
    printComparison(database, data, map);

    if (!values['dry-run'] && !values.yes) {
      console.log('');
      console.log(`Stichtag: ${new Date(cutoff * 1000).toISOString()}.`);
      console.log('Zeiten davor kommen aus dem alten System, danach aus der eigenen Erfassung.');
      if (!(await confirm('Übernehmen?'))) {
        console.log('Abgebrochen.');
        return;
      }
    }

    const report = importRanking(database, data, {
      cutoff,
      dryRun: values['dry-run'],
      minSeconds: minMinutes * 60,
    });
    printReport(report, values['dry-run']);
    if (!values['dry-run']) {
      console.log('');
      console.log('Nächster Schritt: Rang-Lauf im Probemodus prüfen (Seite „Ränge“).');
    }
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error('Import fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
