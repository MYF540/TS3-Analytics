import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';

export const RANK_SETTINGS_KEY = 'ranks';

export const rankSettingsSchema = z.object({
  /** Which time counts: all connected time (default, like the old ranking) or active time only. */
  countMode: z.enum(['online', 'active']).default('online'),
  /** Players in one of these server groups are never ranked (e.g. admins, bots). */
  excludedGroupIds: z.array(z.number().int().positive()).max(100).default([]),
  /** AGENTS.md rule 7: automations that change the server start in dry-run mode. */
  dryRun: z.boolean().default(true),
  /** Minutes between rank job runs. */
  intervalMinutes: z.number().int().min(1).max(1440).default(10),
  /** Private text message on promotion (decision 19.09.2026); `{rank}` is replaced. */
  promotionMessage: z
    .object({
      enabled: z.boolean(),
      text: z.string().trim().min(1).max(1024),
    })
    .default({ enabled: true, text: 'Glückwunsch! Du hast den Rang „{rank}“ erreicht.' }),
  /** Also report promotions to Discord (event `rank.promoted`). */
  discord: z.boolean().default(false),
});

export type RankSettings = z.infer<typeof rankSettingsSchema>;

export function loadRankSettings(db: DbExecutor): RankSettings {
  return getSetting(db, RANK_SETTINGS_KEY, rankSettingsSchema) ?? rankSettingsSchema.parse({});
}

export function saveRankSettings(
  db: DbExecutor,
  settings: z.input<typeof rankSettingsSchema>,
  now: number,
): void {
  setSetting(db, RANK_SETTINGS_KEY, rankSettingsSchema.parse(settings), now);
}
