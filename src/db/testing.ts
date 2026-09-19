import { IN_MEMORY, openDatabase, runMigrations, type AppDatabase } from './client.js';

/** Fresh, migrated in-memory database for tests. */
export function createTestDatabase(): AppDatabase {
  const database = openDatabase({ path: IN_MEMORY, cacheSizeMb: 16, mmapSizeMb: 0 });
  runMigrations(database);
  return database;
}
