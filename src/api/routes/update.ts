import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { UpdateError } from '../../update/updater.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

export const updateResponse = z.object({
  /** False when the service runs without the updater (update check switched off, tools). */
  enabled: z.boolean(),
  currentVersion: z.string(),
  latest: z
    .object({
      version: z.string(),
      url: z.string(),
      publishedAt: z.number().int().nullable(),
      notes: z.string(),
      checkedAt: z.number().int(),
    })
    .nullable(),
  updateAvailable: z.boolean(),
  /** Why "update now" is not offered; null when it is. */
  installBlocker: z.enum(['platform', 'no_git', 'no_script']).nullable(),
  /** The last run of the setup script, as far as it left a status. */
  lastRun: z
    .object({
      state: z.enum(['running', 'done', 'failed']),
      version: z.string(),
      at: z.number().int(),
      message: z.string(),
    })
    .nullable(),
});

const STATUS: Record<UpdateError['code'], number> = {
  UPDATE_CHECK_FAILED: 502,
  UPDATE_NOT_AVAILABLE: 409,
  UPDATE_UNSUPPORTED: 409,
};

/** Version check against the GitHub releases and starting an update – admins only. */
export function updateRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const response = () => {
      const updater = context.updater;
      if (!updater) {
        return {
          enabled: false,
          currentVersion: 'unbekannt',
          latest: null,
          updateAvailable: false,
          installBlocker: null,
          lastRun: null,
        };
      }
      return {
        enabled: true,
        currentVersion: updater.currentVersion,
        latest: updater.latest() ?? null,
        updateAvailable: updater.updateAvailable(),
        installBlocker: updater.installBlocker() ?? null,
        lastRun: updater.lastRun() ?? null,
      };
    };
    const required = () => {
      if (!context.updater) throw new ApiError(409, 'UPDATE_UNSUPPORTED', 'Updater not available');
      return context.updater;
    };
    const translate = (error: unknown): never => {
      if (error instanceof UpdateError)
        throw new ApiError(STATUS[error.code], error.code, error.code);
      throw error;
    };

    app.get(
      '/update',
      { config: { auth: 'admin' }, schema: { response: { 200: updateResponse } } },
      () => response(),
    );

    app.post(
      '/update/check',
      { config: { auth: 'admin' }, schema: { response: { 200: updateResponse } } },
      async () => {
        await required().check().catch(translate);
        return response();
      },
    );

    // Takes no version: only the release found by the last check can be installed.
    app.post(
      '/update/install',
      { config: { auth: 'admin' }, schema: { response: { 200: updateResponse } } },
      async (request) => {
        const updater = required();
        request.audit({
          action: 'update.install',
          targetType: 'system',
          targetId: 'update',
          details: { from: updater.currentVersion, to: updater.latest()?.version ?? null },
        });
        await updater.install().catch(translate);
        return response();
      },
    );

    return Promise.resolve();
  };
}
