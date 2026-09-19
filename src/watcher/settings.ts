import { z } from 'zod';
import type { DbExecutor } from '../db/repositories/index.js';
import { getSetting, setSetting } from '../db/repositories/index.js';
import { DEFAULT_ACTIVITY_SETTINGS, type ActivitySettings } from '../domain/activity.js';

export const ACTIVITY_SETTINGS_KEY = 'activity';

const D = DEFAULT_ACTIVITY_SETTINGS;

/** Stored activity settings; missing keys fall back to the defaults. */
export const activitySettingsSchema = z.object({
  idleThresholdS: z.number().int().min(60).max(86_400).default(D.idleThresholdS),
  afkChannelIds: z.array(z.number().int().positive()).default(D.afkChannelIds),
  awayIsAfk: z.boolean().default(D.awayIsAfk),
  outputMutedIsAfk: z.boolean().default(D.outputMutedIsAfk),
});

export function loadActivitySettings(db: DbExecutor): ActivitySettings {
  return (
    getSetting(db, ACTIVITY_SETTINGS_KEY, activitySettingsSchema) ??
    activitySettingsSchema.parse({})
  );
}

export function saveActivitySettings(
  db: DbExecutor,
  settings: ActivitySettings,
  now: number,
): void {
  setSetting(db, ACTIVITY_SETTINGS_KEY, activitySettingsSchema.parse(settings), now);
}
