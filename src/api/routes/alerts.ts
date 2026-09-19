import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { TEST_ALERT } from '../../alerts/messages.js';
import { AlertNotifier } from '../../alerts/notifier.js';
import {
  ALERT_EVENTS,
  loadAlertSettings,
  maskWebhook,
  saveAlertSettings,
  WEBHOOK_URL_PATTERN,
} from '../../alerts/settings.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

export const alertSettingsResponse = z.object({
  configured: z.boolean(),
  /** Last characters of the webhook token; the URL itself is never returned. */
  webhookHint: z.string().nullable(),
  events: z.array(z.enum(ALERT_EVENTS)),
  ratePerMinute: z.number().int(),
});

const alertSettingsBody = z.object({
  /** Omitted: keep the stored URL. `null`: remove it. */
  webhookUrl: z.string().trim().nullable().optional(),
  events: z.array(z.enum(ALERT_EVENTS)).max(ALERT_EVENTS.length),
  ratePerMinute: z.number().int().min(1).max(30),
});

/**
 * Discord alert settings (T5.4), admins only. The webhook URL is a secret: it is accepted but
 * never sent back, and the audit log only records whether it was set, changed or removed.
 */
export function alertRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;
    const response = () => {
      const settings = loadAlertSettings(db);
      return {
        configured: settings.webhookUrl !== null,
        webhookHint: maskWebhook(settings.webhookUrl),
        events: settings.events,
        ratePerMinute: settings.ratePerMinute,
      };
    };

    app.get(
      '/settings/alerts',
      { config: { auth: 'admin' }, schema: { response: { 200: alertSettingsResponse } } },
      () => response(),
    );

    app.put(
      '/settings/alerts',
      {
        config: { auth: 'admin' },
        schema: { body: alertSettingsBody, response: { 200: alertSettingsResponse } },
      },
      (request) => {
        const before = loadAlertSettings(db);
        const { webhookUrl, events, ratePerMinute } = request.body;
        const nextUrl = webhookUrl === undefined ? before.webhookUrl : webhookUrl || null;
        const webhook =
          nextUrl === before.webhookUrl ? 'unchanged' : nextUrl === null ? 'removed' : 'set';
        request.audit({
          action: 'settings.alerts',
          targetType: 'settings',
          targetId: 'alerts',
          details: { webhook, events: [...new Set(events)], ratePerMinute },
        });
        if (nextUrl !== null && !WEBHOOK_URL_PATTERN.test(nextUrl)) {
          throw new ApiError(400, 'INVALID_WEBHOOK', 'Not a Discord webhook URL');
        }
        saveAlertSettings(
          db,
          { webhookUrl: nextUrl, events: [...new Set(events)], ratePerMinute },
          context.now(),
        );
        return response();
      },
    );

    app.post(
      '/settings/alerts/test',
      {
        config: { auth: 'admin' },
        schema: {
          response: {
            200: z.object({ ok: z.boolean(), status: z.number().int().nullable() }),
          },
        },
      },
      async (request) => {
        request.audit({
          action: 'settings.alerts_test',
          targetType: 'settings',
          targetId: 'alerts',
        });
        if (!loadAlertSettings(db).webhookUrl) {
          throw new ApiError(409, 'NO_WEBHOOK', 'No webhook configured');
        }
        const result = await new AlertNotifier({ db, logger: context.logger }).sendTest(TEST_ALERT);
        return result.ok ? { ok: true, status: null } : result;
      },
    );
    return Promise.resolve();
  };
}
