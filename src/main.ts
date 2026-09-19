import { loadConfigOrExit } from './config/config.js';
import { openDatabase, runMigrations } from './db/client.js';
import { createLogger } from './logging/logger.js';

function main(): void {
  const config = loadConfigOrExit();
  const logger = createLogger(config.logging);
  logger.info(
    { logLevel: config.logging.level, logDir: config.logging.dir },
    'TS3 Analytics starting',
  );
  const database = openDatabase(config.database);
  runMigrations(database);
  logger.info({ path: config.database.path }, 'Database ready');
  // Services (watcher, api) are wired up here in later tasks.
}

main();
