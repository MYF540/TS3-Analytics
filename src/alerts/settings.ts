import { z } from 'zod';
import { getSetting, setSetting, type DbExecutor } from '../db/repositories/index.js';

export const ALERTS_KEY = 'alerts';

/** Event types that can be sent to Discord. T5.5/T5.7 add their types here. */
export const ALERT_EVENTS = [
  'flag.high',
  'flag.medium',
  'ban.added',
  'bot.connection',
  'join.spike',
  'group.protected',
] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];

/** Only real Discord webhook endpoints are accepted (no arbitrary outgoing requests). */
export const WEBHOOK_URL_PATTERN =
  /^https:\/\/(?:(?:canary|ptb)\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]+$/;

export const alertSettingsSchema = z.object({
  /** Secret: never returned by the API, never logged. */
  webhookUrl: z.string().regex(WEBHOOK_URL_PATTERN).nullable().default(null),
  events: z.array(z.enum(ALERT_EVENTS)).default(['flag.high', 'bot.connection']),
  /** Messages per minute; further messages are summarised. */
  ratePerMinute: z.number().int().min(1).max(30).default(10),
  /** Join spike (T5.5): at least `threshold` new UIDs within `windowMinutes`. */
  joinSpike: z
    .object({
      windowMinutes: z.number().int().min(1).max(240),
      threshold: z.number().int().min(2).max(1000),
    })
    .default({ windowMinutes: 10, threshold: 10 }),
});

export type AlertSettings = z.infer<typeof alertSettingsSchema>;

export function loadAlertSettings(db: DbExecutor): AlertSettings {
  return getSetting(db, ALERTS_KEY, alertSettingsSchema) ?? alertSettingsSchema.parse({});
}

export function saveAlertSettings(
  db: DbExecutor,
  settings: z.input<typeof alertSettingsSchema>,
  now: number,
): void {
  setSetting(db, ALERTS_KEY, alertSettingsSchema.parse(settings), now);
}

/** Shows only the last four characters of the token, e.g. `…Ab3x`. */
export function maskWebhook(url: string | null): string | null {
  return url === null ? null : `…${url.slice(-4)}`;
}
