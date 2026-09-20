/**
 * Measures the core read queries against a (synthetic) database.
 *
 *   pnpm bench [--db data/synthetic.sqlite] [--runs 30]
 *
 * Prints a Markdown table (median / p95 / max in ms) for docs/performance.md. Budget: 100 ms.
 */
import { existsSync } from 'node:fs';
import { cpus, totalmem } from 'node:os';
import { parseArgs } from 'node:util';
import { openDatabase } from '../db/client.js';
import { channelUsage, unusedChannels } from '../db/queries/channels.js';
import {
  countLeaderboardForDays,
  leaderboardAllTime,
  listUsers,
  leaderboardForDays,
  onlineSeries,
  overview,
  searchUsers,
  userDetail,
  userWeekdayHourHeatmap,
  weekdayHourHeatmap,
} from '../db/queries/stats.js';
import { berlinDay, berlinDayStart } from '../domain/time.js';
import { computeNetwork } from '../network/job.js';
import { DEFAULT_NETWORK_SETTINGS } from '../network/settings.js';

export const BUDGET_MS = 100;

interface Result {
  name: string;
  median: number;
  p95: number;
  max: number;
  /** What this case may take; interactive queries get `BUDGET_MS`. */
  budgetMs: number;
}

/** A nightly job may take seconds – nobody waits for it. */
export const JOB_BUDGET_MS = 5000;

function measure(name: string, runs: number, fn: () => unknown, budgetMs = BUDGET_MS): Result {
  for (let i = 0; i < 3; i++) fn(); // warm-up (statement cache, page cache)
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = process.hrtime.bigint();
    fn();
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))] ?? 0;
  return { name, median: at(0.5), p95: at(0.95), max: times[times.length - 1] ?? 0, budgetMs };
}

function main(): void {
  const { values } = parseArgs({
    options: {
      db: { type: 'string', default: './data/synthetic.sqlite' },
      runs: { type: 'string', default: '30' },
    },
    strict: true,
  });
  if (!existsSync(values.db)) {
    console.error(`${values.db} not found. Create it with: pnpm seed:synthetic`);
    process.exit(2);
  }
  const runs = Math.max(1, Number(values.runs));
  const database = openDatabase({ path: values.db, cacheSizeMb: 64, mmapSizeMb: 256 });
  const { sqlite } = database;

  try {
    const count = (table: string) =>
      sqlite.prepare(`SELECT count(*) FROM ${table}`).pluck().get() as number;
    const sizes = {
      users: count('users'),
      sessions: count('sessions'),
      segments: count('activity_segments'),
      daily: count('user_daily_stats'),
      hours: count('server_hourly'),
    };

    const lastHour = (sqlite.prepare(`SELECT max(hour) FROM server_hourly`).pluck().get() ??
      0) as number;
    const now = lastHour + 3600;
    const today = berlinDay(now - 1);
    const daysBack = (n: number) => berlinDay(now - n * 86_400);
    const since = (days: number) => berlinDayStart(daysBack(days));
    const firstHour = (sqlite.prepare(`SELECT min(hour) FROM server_hourly`).pluck().get() ??
      0) as number;

    // Heaviest user (most segments) for the worst case of the player page.
    const heavyUser = sqlite
      .prepare(`SELECT user_id FROM user_totals ORDER BY online_s DESC LIMIT 1`)
      .pluck()
      .get() as number;
    const page = { limit: 25, offset: 0 };

    const results: Result[] = [
      measure('Leaderboard gesamt (online)', runs, () =>
        leaderboardAllTime(sqlite, 'online', page),
      ),
      measure('Leaderboard gesamt (aktiv)', runs, () => leaderboardAllTime(sqlite, 'active', page)),
      measure('Leaderboard längste Session (gesamt)', runs, () =>
        leaderboardAllTime(sqlite, 'longestSession', page),
      ),
      measure('Leaderboard Woche', runs, () =>
        leaderboardForDays(sqlite, 'online', daysBack(6), today, page),
      ),
      measure('Leaderboard Monat', runs, () =>
        leaderboardForDays(sqlite, 'online', daysBack(29), today, page),
      ),
      measure('Leaderboard Jahr', runs, () =>
        leaderboardForDays(sqlite, 'online', daysBack(364), today, page),
      ),
      measure('Leaderboard Jahr, Seite 10', runs, () =>
        leaderboardForDays(sqlite, 'active', daysBack(364), today, { limit: 25, offset: 225 }),
      ),
      measure('Leaderboard frei (gesamter Zeitraum über Tage)', runs, () =>
        leaderboardForDays(sqlite, 'online', 0, today, page),
      ),
      measure('Nutzerdetail (aktivster Nutzer, 1 Jahr Verlauf)', runs, () =>
        userDetail(sqlite, heavyUser, daysBack(365)),
      ),
      measure('Dashboard Kennzahlen (30 Tage)', runs, () =>
        overview(sqlite, since(30), now, since(0)),
      ),
      measure('Online-Verlauf 24 h', runs, () => onlineSeries(sqlite, now - 86_400, now)),
      measure('Online-Verlauf 30 Tage', runs, () => onlineSeries(sqlite, since(30), now)),
      measure('Online-Verlauf 1 Jahr', runs, () => onlineSeries(sqlite, since(365), now)),
      measure('Online-Verlauf gesamt', runs, () => onlineSeries(sqlite, firstHour, now)),
      measure('Heatmap 30 Tage', runs, () => weekdayHourHeatmap(sqlite, since(30), now)),
      measure('Heatmap 1 Jahr', runs, () => weekdayHourHeatmap(sqlite, since(365), now)),
      measure('Heatmap gesamt', runs, () => weekdayHourHeatmap(sqlite, firstHour, now)),
      measure('Spieler-Heatmap 1 Jahr', runs, () =>
        userWeekdayHourHeatmap(sqlite, heavyUser, since(365), now),
      ),
      measure('Spieler-Heatmap gesamt', runs, () =>
        userWeekdayHourHeatmap(sqlite, heavyUser, firstHour, now),
      ),
      // The network is computed by a daily job (T9.1); measured without writing.
      measure(
        'Netzwerk 30 Tage (Job)',
        runs,
        () => computeNetwork(database, '30d', now, firstHour, DEFAULT_NETWORK_SETTINGS, []),
        JOB_BUDGET_MS,
      ),
      measure(
        'Netzwerk 90 Tage (Job)',
        runs,
        () => computeNetwork(database, '90d', now, firstHour, DEFAULT_NETWORK_SETTINGS, []),
        JOB_BUDGET_MS,
      ),
      measure('Leaderboard Jahr, Anzahl (Paginierung)', runs, () =>
        countLeaderboardForDays(sqlite, 'online', daysBack(364), today),
      ),
      measure('Nutzerliste (Standardfilter, nach Spielzeit)', runs, () =>
        listUsers(sqlite, {
          sort: 'online',
          order: 'desc',
          limit: 50,
          offset: 0,
          minOnlineS: 3600,
        }),
      ),
      measure('Nutzerliste (alle, nach Nickname, Seite 20)', runs, () =>
        listUsers(sqlite, {
          sort: 'nickname',
          order: 'asc',
          limit: 50,
          offset: 950,
          minOnlineS: 0,
        }),
      ),
      measure('Nutzerliste mit Suche', runs, () =>
        listUsers(sqlite, {
          search: 'wolf',
          sort: 'lastSeen',
          order: 'desc',
          limit: 50,
          offset: 0,
          minOnlineS: 0,
        }),
      ),
      measure('Suche Nick (Teilstring, 4 Zeichen)', runs, () => searchUsers(sqlite, 'hunt')),
      measure('Suche Nick (2 Zeichen, Präfix)', runs, () => searchUsers(sqlite, 'Sh')),
      measure('Suche UID-Präfix', runs, () => searchUsers(sqlite, 'aB')),
      measure('Channel-Nutzung 30 Tage', runs, () =>
        channelUsage(sqlite, {
          from: since(30),
          to: now,
          limit: 100,
          presentSince: now - 86_400,
        }),
      ),
      measure('Channel-Nutzung 24 h', runs, () =>
        channelUsage(sqlite, {
          from: now - 86_400,
          to: now,
          limit: 100,
          presentSince: now - 86_400,
        }),
      ),
      measure('Ungenutzte Channels (90 Tage)', runs, () =>
        unusedChannels(sqlite, { since: since(90), now, presentSince: now - 86_400 }),
      ),
    ];

    const fmt = (n: number) => n.toFixed(1);
    console.log(
      `Datenbestand: ${String(sizes.users)} Nutzer, ${String(sizes.sessions)} Sessions, ` +
        `${String(sizes.segments)} Segmente, ${String(sizes.daily)} Tageszeilen, ` +
        `${String(sizes.hours)} Stundenzeilen`,
    );
    console.log(
      `System: ${cpus()[0]?.model ?? 'unbekannt'}, ${String(Math.round(totalmem() / 2 ** 30))} GB RAM, ` +
        `Node ${process.version}, ${String(runs)} Läufe je Abfrage\n`,
    );
    console.log('| Abfrage | Median (ms) | p95 (ms) | Max (ms) | Budget |');
    console.log('| --- | ---: | ---: | ---: | :---: |');
    for (const r of results) {
      const ok = r.p95 < r.budgetMs ? '✅' : '❌';
      console.log(`| ${r.name} | ${fmt(r.median)} | ${fmt(r.p95)} | ${fmt(r.max)} | ${ok} |`);
    }
    const failed = results.filter((r) => r.p95 >= r.budgetMs);
    if (failed.length > 0) {
      console.error(
        `\n${String(failed.length)} Abfrage(n) über dem Budget von ${String(BUDGET_MS)} ms`,
      );
      process.exitCode = 1;
    }
  } finally {
    database.close();
  }
}

main();
