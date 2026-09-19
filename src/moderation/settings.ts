import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';

export const MODERATION_KEY = 'moderation';

/** Upper bound for ban durations: ten years (longer = use "permanent", 0). */
export const MAX_BAN_S = 10 * 365 * 86_400;

export const banTemplateSchema = z.object({
  id: z.string().regex(/^[\w-]{1,32}$/),
  label: z.string().trim().min(1).max(60),
  reason: z.string().trim().min(1).max(200),
  /** 0 = permanent. */
  durationS: z.number().int().min(0).max(MAX_BAN_S),
});

export type BanTemplate = z.infer<typeof banTemplateSchema>;

export const DEFAULT_BAN_TEMPLATES: BanTemplate[] = [
  { id: 'spam', label: 'Spam', reason: 'Spam', durationS: 3600 },
  { id: 'insult', label: 'Beleidigung', reason: 'Beleidigung', durationS: 86_400 },
  { id: 'cheating', label: 'Cheating', reason: 'Cheating', durationS: 0 },
];

export const moderationSettingsSchema = z.object({
  /** Global switch (decision 19.09.2026): off by default; the API refuses actions while off. */
  enabled: z.boolean().default(false),
  banTemplates: z.array(banTemplateSchema).max(20).default(DEFAULT_BAN_TEMPLATES),
});

export type ModerationSettings = z.infer<typeof moderationSettingsSchema>;

export function loadModerationSettings(db: DbExecutor): ModerationSettings {
  return (
    getSetting(db, MODERATION_KEY, moderationSettingsSchema) ?? moderationSettingsSchema.parse({})
  );
}

export function saveModerationSettings(
  db: DbExecutor,
  settings: z.input<typeof moderationSettingsSchema>,
  now: number,
): void {
  setSetting(db, MODERATION_KEY, moderationSettingsSchema.parse(settings), now);
}
