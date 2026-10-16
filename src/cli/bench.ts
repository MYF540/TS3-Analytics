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
import { networkGraph } from '../db/queries/network.js';
import { computeNetwork } from '../network/job.js';
import { FactsReader } from '../achievements/facts.js';
import { globalFacts, runAchievementJob } from '../achievements/job.js';
import { ACHIEVEMENT_STATE_KEY, loadAchievementState } from '../achievements/settings.js';
import {
  achievementHolders,
  achievementOverview,
  personAchievements,
} from '../db/queries/achievements.js';
import { achievementProgress, ACHIEVEMENT_IDS } from '../domain/achievements.js';
import { DEFAULT_NETWORK_SETTINGS } from '../network/settings.js';
import { loyaltyCohorts, loyaltyMonths, missingRegulars } from '../db/queries/loyalty.js';
import { runLoyaltyJob } from '../loyalty/job.js';

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

function measure(
  name: string,
  runs: number,
  fn: () => unknown,
  budgetMs = BUDGET_MS,
  warmups = 3,
): Result {
  for (let i = 0; i < warmups; i++) fn(); // warm-up (statement cache, page cache)
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
    const networkFocus =
      (sqlite
        .prepare(`SELECT user_id FROM network_nodes WHERE range = '1y' ORDER BY seconds DESC`)
        .pluck()
        .get() as number | undefined) ?? heavyUser;
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
      // Reading the stored network (T12.2) – only meaningful after the job ran on this file.
      measure('Netzwerk lesen 1 Jahr, 1.500 Verbindungen', runs, () =>
        networkGraph(sqlite, { range: '1y', limit: 1500 }),
      ),
      measure('Netzwerk Umfeld eines Spielers, 2 Schritte', runs, () =>
        networkGraph(sqlite, {
          range: '1y',
          limit: 1500,
          focus: { userId: networkFocus, depth: 2 },
        }),
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

    // Achievements (T13.3/T13.4): everything runs inside a savepoint that is rolled back, so the
    // benchmark leaves the database as it was.
    sqlite.exec('SAVEPOINT bench_achievements');
    try {
      const fullRun = () => {
        sqlite.prepare('DELETE FROM settings WHERE key = ?').run(ACHIEVEMENT_STATE_KEY);
        sqlite.exec('DELETE FROM achievements_earned');
        runAchievementJob(database, now);
      };
      results.push(
        measure('Achievements Voll-Lauf mit Nachberechnung (Job)', 1, fullRun, 60_000, 0),
      );
      fullRun();
      results.push(
        measure(
          // Pessimistic: everybody of the last hour instead of the last 15 minutes.
          'Achievements normaler Lauf (Job, Spieler der letzten Stunde)',
          runs,
          () => {
            sqlite
              .prepare(`UPDATE settings SET value = json_set(value, '$.lastRun', ?) WHERE key = ?`)
              .run(now - 3600, ACHIEVEMENT_STATE_KEY);
            return runAchievementJob(database, now);
          },
          JOB_BUDGET_MS,
        ),
        measure('Achievements Übersicht', runs, () => {
          achievementOverview(sqlite, ACHIEVEMENT_IDS, 10);
        }),
        measure('Achievements Inhaber (Stammgast, Seite 1)', runs, () =>
          achievementHolders(sqlite, 'regular', { limit: 50, offset: 0 }),
        ),
        measure('Achievements Spielerseite (aktivster Nutzer)', runs, () => {
          personAchievements(sqlite, [heavyUser]);
          const { globals } = globalFacts(
            sqlite,
            database.db,
            now,
            loadAchievementState(database.db),
          );
          const facts = new FactsReader(sqlite, globals).read(heavyUser, [heavyUser]);
          if (facts) achievementProgress(facts);
        }),
      );
    } finally {
      sqlite.exec('ROLLBACK TO bench_achievements');
      sqlite.exec('RELEASE bench_achievements');
    }

    // Retention (T13.1): the daily job fills the cache, the page only reads it. Rolled back too.
    sqlite.exec('SAVEPOINT bench_loyalty');
    try {
      results.push(
        measure('Bindung Neuberechnung (Job)', 1, () => runLoyaltyJob(database, now), 60_000, 0),
      );
      const fourWeeksAgo = berlinDay(now - 28 * 86_400);
      results.push(
        measure('Bindung Kohorten und Monatsbilanz', runs, () => {
          loyaltyCohorts(sqlite);
          loyaltyMonths(sqlite);
        }),
        measure('Bindung vermisste Stammspieler (20 h, 4 Wochen, Seite 1)', runs, () =>
          missingRegulars(sqlite, {
            minRecentS: 20 * 3600,
            lastDayBefore: fourWeeksAgo,
            limit: 50,
            offset: 0,
          }),
        ),
        measure('Bindung vermisste Stammspieler (CSV, alle)', runs, () =>
          missingRegulars(sqlite, {
            minRecentS: 20 * 3600,
            lastDayBefore: fourWeeksAgo,
            limit: 1_000_000,
            offset: 0,
          }),
        ),
      );
    } finally {
      sqlite.exec('ROLLBACK TO bench_loyalty');
      sqlite.exec('RELEASE bench_loyalty');
    }

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
