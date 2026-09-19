import { ConfigError, loadConfig } from './config/config.js';

function main(): void {
  try {
    loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  // Services (db, watcher, api) are wired up here in later tasks.
}

main();
