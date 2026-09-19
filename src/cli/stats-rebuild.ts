/**
 * Recomputes user_daily_stats, user_totals and server_hourly from sessions and segments.
 *
 *   pnpm stats:rebuild [--from YYYY-MM-DD] [--to YYYY-MM-DD]
 *
 * Days are Berlin calendar days, both inclusive. Stop the service first for a consistent result.
 */
import { parseArgs } from 'node:util';
import { loadConfigOrExit } from '../config/config.js';
import { rebuildAggregates } from '../db/aggregates.js';
import { openDatabase, runMigrations } from '../db/client.js';
import { parseDay } from '../domain/time.js';
import { createLogger } from '../logging/logger.js';

function parseDayOption(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const day = parseDay(value);
  if (day === undefined) {
    console.error(`--${name} must be a date in the form YYYY-MM-DD, got "${value}"`);
    process.exit(2);
  }
  return day;
}

function main(): void {
  const { values } = parseArgs({
    options: { from: { type: 'string' }, to: { type: 'string' } },
    strict: true,
  });
  const fromDay = parseDayOption('from', values.from);
  const toDay = parseDayOption('to', values.to);
  if (fromDay !== undefined && toDay !== undefined && fromDay > toDay) {
    console.error('--from must not be after --to');
    process.exit(2);
  }

  const config = loadConfigOrExit();
  const logger = createLogger(config.logging);
  const database = openDatabase(config.database);
  try {
    runMigrations(database);
    logger.info({ from: values.from ?? 'start', to: values.to ?? 'end' }, 'Rebuilding aggregates');
    const started = Date.now();
    let lastReport = 0;
    const result = rebuildAggregates(database, {
      fromDay,
      toDay,
      onProgress: (done, total) => {
        const percent = Math.floor((done / total) * 100);
        if (percent >= lastReport + 10 || done === total) {
          lastReport = percent;
          logger.info({ done, total }, `Users processed: ${String(percent)} %`);
        }
      },
    });
    logger.info({ ...result, durationMs: Date.now() - started }, 'Aggregates rebuilt');
  } finally {
    database.close();
  }
}

main();
