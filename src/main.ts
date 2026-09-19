import { loadConfigOrExit } from './config/config.js';
import { openDatabase, runMigrations } from './db/client.js';
import { openCountryLookup } from './geoip/country-lookup.js';
import { createLogger } from './logging/logger.js';
import { Ts3Connection } from './ts3/connection.js';
import { RealTs3Transport } from './ts3/real-transport.js';
import { Watcher } from './watcher/watcher.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const logger = createLogger(config.logging);
  logger.info(
    { logLevel: config.logging.level, logDir: config.logging.dir },
    'TS3 Analytics starting',
  );
  const database = openDatabase(config.database);
  runMigrations(database);
  logger.info({ path: config.database.path }, 'Database ready');

  const connection = new Ts3Connection(
    () => new RealTs3Transport(config.ts3, logger),
    { commandsPerSecond: config.ts3.queryRateLimit },
    { logger },
  );
  const countries = await openCountryLookup(config.paths.geoipDb, logger);
  const watcher = new Watcher({
    database,
    connection,
    logger,
    ip: { countries, hmacSecret: config.security.hmacSecret },
    pollIntervalS: config.watcher.pollIntervalS,
    flushIntervalS: config.watcher.flushIntervalS,
  });
  watcher.start();
  connection.start();
  // API is wired up here in a later task.

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'Shutting down');
    try {
      watcher.stop();
    } catch (error) {
      logger.error({ err: error }, 'Error while closing open sessions');
    }
    void connection
      .stop()
      .catch((error: unknown) => {
        logger.error({ err: error }, 'Error while closing the TS3 connection');
      })
      .finally(() => {
        database.close();
        logger.flush();
        process.exit(0);
      });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
