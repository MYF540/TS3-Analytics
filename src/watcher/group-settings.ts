import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';

export const GROUP_WATCH_KEY = 'groupWatch';
export const GROUP_LOG_POS_KEY = 'groupWatch.lastPos';

export const groupWatchSchema = z.object({
  /** Changes of these server groups are alerted (T5.7). */
  protectedGroupIds: z.array(z.number().int().positive()).max(100).default([]),
  /** Last known group list, so the settings page works while the bot is offline. */
  knownGroups: z
    .array(z.object({ id: z.number().int(), name: z.string() }))
    .max(500)
    .default([]),
});

export type GroupWatchSettings = z.infer<typeof groupWatchSchema>;

export function loadGroupWatch(db: DbExecutor): GroupWatchSettings {
  return getSetting(db, GROUP_WATCH_KEY, groupWatchSchema) ?? groupWatchSchema.parse({});
}

export function saveGroupWatch(
  db: DbExecutor,
  settings: z.input<typeof groupWatchSchema>,
  now: number,
): void {
  setSetting(db, GROUP_WATCH_KEY, groupWatchSchema.parse(settings), now);
}
