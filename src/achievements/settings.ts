import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';
import { ACHIEVEMENT_IDS } from '../domain/achievements.js';

export const ACHIEVEMENT_SETTINGS_KEY = 'achievements';
export const ACHIEVEMENT_STATE_KEY = 'achievements.state';

export const achievementSettingsSchema = z.object({
  /** Switched off in the web interface: not evaluated and not shown, earned rows stay. */
  disabled: z
    .array(z.string())
    .max(200)
    .default([])
    // Ids that left the catalog are dropped silently.
    .transform((ids) => [...new Set(ids.filter((id) => ACHIEVEMENT_IDS.includes(id)))].sort()),
});

export type AchievementSettings = z.infer<typeof achievementSettingsSchema>;

export function loadAchievementSettings(db: DbExecutor): AchievementSettings {
  return (
    getSetting(db, ACHIEVEMENT_SETTINGS_KEY, achievementSettingsSchema) ??
    achievementSettingsSchema.parse({})
  );
}

export function saveAchievementSettings(
  db: DbExecutor,
  settings: z.input<typeof achievementSettingsSchema>,
  now: number,
): void {
  setSetting(db, ACHIEVEMENT_SETTINGS_KEY, achievementSettingsSchema.parse(settings), now);
}

/** What the last run did; `fingerprint` decides whether the next run has to check everybody. */
export const achievementStateSchema = z.object({
  lastRun: z.number().int(),
  fingerprint: z.string(),
  full: z.boolean(),
  checked: z.number().int(),
  awarded: z.number().int(),
  seconds: z.number(),
});

export type AchievementState = z.infer<typeof achievementStateSchema>;

export function loadAchievementState(db: DbExecutor): AchievementState | undefined {
  return getSetting(db, ACHIEVEMENT_STATE_KEY, achievementStateSchema);
}

export function saveAchievementState(db: DbExecutor, state: AchievementState, now: number): void {
  setSetting(db, ACHIEVEMENT_STATE_KEY, achievementStateSchema.parse(state), now);
}
