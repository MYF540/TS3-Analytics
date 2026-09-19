import { ConfigError, loadConfig, type Config } from './config/config.js';
import { createLogger } from './logging/logger.js';

function readConfig(): Config {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      // No logger yet: its settings are part of the invalid config.
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
}

function main(): void {
  const config = readConfig();
  const logger = createLogger(config.logging);
  logger.info(
    { logLevel: config.logging.level, logDir: config.logging.dir },
    'TS3 Analytics starting',
  );
  // Services (db, watcher, api) are wired up here in later tasks.
}

main();
