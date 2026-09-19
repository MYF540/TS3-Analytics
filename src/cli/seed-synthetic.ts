/**
 * Creates a database with synthetic data for performance tests.
 *
 *   pnpm seed:synthetic [--out data/synthetic.sqlite] [--years 6] [--regular 500]
 *                       [--casual 8000] [--seed 42] [--force]
 *
 * Writes to its own file and refuses to overwrite an existing one without --force.
 */
import { existsSync, rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { rebuildAggregates } from '../db/aggregates.js';
import { openDatabase, runMigrations } from '../db/client.js';
import { generateSyntheticData } from '../db/synthetic.js';
import { berlinDay, berlinDayStart } from '../domain/time.js';

export const DEFAULT_SYNTHETIC_PATH = './data/synthetic.sqlite';

function positiveNumber(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`--${name} must be a positive number`);
    process.exit(2);
  }
  return n;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: 'string', default: DEFAULT_SYNTHETIC_PATH },
      years: { type: 'string', default: '6' },
      regular: { type: 'string', default: '500' },
      casual: { type: 'string', default: '8000' },
      seed: { type: 'string', default: '42' },
      force: { type: 'boolean', default: false },
    },
    strict: true,
  });

  const out = values.out;
  if (existsSync(out)) {
    if (!values.force) {
      console.error(`${out} already exists. Use --force to replace it.`);
      process.exit(2);
    }
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${out}${suffix}`, { force: true });
  }

  const database = openDatabase({ path: out, cacheSizeMb: 256, mmapSizeMb: 1024 });
  try {
    runMigrations(database);
    // Throwaway file: durability does not matter while seeding.
    database.sqlite.pragma('synchronous = OFF');

    // End at today's Berlin midnight so runs on the same day produce the same data.
    const endAt = berlinDayStart(berlinDay(Math.floor(Date.now() / 1000)));
    const started = Date.now();
    const result = generateSyntheticData(database.sqlite, {
      years: positiveNumber('years', values.years),
      regularUsers: positiveNumber('regular', values.regular),
      casualUsers: positiveNumber('casual', values.casual),
      seed: positiveNumber('seed', values.seed),
      endAt,
      onProgress: (message) => {
        console.log(`  ${message}`);
      },
    });
    const generatedMs = Date.now() - started;
    console.log(
      `Generated ${String(result.users)} users, ${String(result.sessions)} sessions, ` +
        `${String(result.segments)} segments, ${String(result.nicknames)} nicknames ` +
        `in ${(generatedMs / 1000).toFixed(1)} s`,
    );

    const rebuildStarted = Date.now();
    const rebuild = rebuildAggregates(database);
    console.log(
      `Rebuilt aggregates (${String(rebuild.dailyRows)} daily rows, ${String(rebuild.hours)} hours) ` +
        `in ${((Date.now() - rebuildStarted) / 1000).toFixed(1)} s`,
    );

    database.sqlite.pragma('synchronous = NORMAL');
    database.sqlite.exec('ANALYZE; PRAGMA optimize;');
    database.sqlite.pragma('wal_checkpoint(TRUNCATE)');
    console.log(`Done: ${out}`);
  } finally {
    database.close();
  }
}

main();
