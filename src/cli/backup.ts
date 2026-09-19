/**
 * Creates a database backup right away, e.g. before an update (T7.1).
 *
 *   pnpm backup
 *
 * Works while the service is running (SQLite online backup). Uses BACKUP_DIR and BACKUP_KEEP
 * from the configuration, like the daily backup job.
 */
import { loadConfigOrExit } from '../config/config.js';
import { openDatabase, runMigrations } from '../db/client.js';
import { runBackup } from '../jobs/backup.js';

async function main(): Promise<void> {
  const config = loadConfigOrExit();
  const database = openDatabase(config.database);
  try {
    runMigrations(database);
    const result = await runBackup(database, {
      dir: config.backup.dir,
      keep: config.backup.keep,
      now: Math.floor(Date.now() / 1000),
    });
    console.log(
      `Sicherung erstellt: ${result.file} (${(result.bytes / 1024 / 1024).toFixed(1)} MB)`,
    );
    if (result.removed.length > 0) {
      console.log(`Alte Sicherungen gelöscht: ${result.removed.join(', ')}`);
    }
  } finally {
    database.close();
  }
}

main().catch((error: unknown) => {
  console.error('Sicherung fehlgeschlagen:', error instanceof Error ? error.message : error);
  process.exit(1);
});
