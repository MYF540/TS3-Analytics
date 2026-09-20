import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';

export const LEGACY_KEY = 'legacy';

export const legacySchema = z.object({
  /**
   * Moment the server switched to this application. Ranking time before it comes from
   * `users.legacy_seconds`, after it from the live tracking – never from both (T8.9).
   */
  cutoff: z.number().int().positive().nullable().default(null),
  /** When the ranking import last ran, for the report on the settings page. */
  importedAt: z.number().int().positive().nullable().default(null),
});

export type LegacySettings = z.infer<typeof legacySchema>;

export function loadLegacy(db: DbExecutor): LegacySettings {
  return getSetting(db, LEGACY_KEY, legacySchema) ?? legacySchema.parse({});
}

export function saveLegacy(
  db: DbExecutor,
  settings: z.input<typeof legacySchema>,
  now: number,
): void {
  setSetting(db, LEGACY_KEY, legacySchema.parse(settings), now);
}
