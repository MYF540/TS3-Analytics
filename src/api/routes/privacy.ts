import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getUserById } from '../../db/repositories/index.js';
import { AnonymizeError, anonymizeUser } from '../../privacy/anonymize.js';
import { exportUser } from '../../privacy/export.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const params = z.object({ id: z.coerce.number().int().positive() });

const ERRORS: Record<AnonymizeError['code'], [number, string]> = {
  USER_NOT_FOUND: [404, 'User not found'],
  ALREADY_ANONYMIZED: [409, 'The player is already anonymized'],
  USER_ONLINE: [409, 'The player is online; disconnect them first'],
};

/**
 * GDPR export and anonymization (T7.2), admins only. The audit log records the action with the
 * internal id only – never the UID.
 */
export function privacyRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;

    app.get(
      '/users/:id/export',
      { config: { auth: 'admin' }, schema: { params } },
      (request, reply) => {
        const { id } = request.params;
        request.audit({ action: 'privacy.export', targetType: 'user', targetId: id });
        const data = exportUser(context.database, id, context.now());
        if (!data) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        return reply
          .header('content-type', 'application/json; charset=utf-8')
          .header('content-disposition', `attachment; filename="spieler-${String(id)}.json"`)
          .header('cache-control', 'no-store')
          .send(JSON.stringify(data, null, 2));
      },
    );

    app.post(
      '/users/:id/anonymize',
      {
        config: { auth: 'admin' },
        schema: {
          params,
          /** The UID has to be typed again, so nobody anonymizes the wrong player. */
          body: z.object({ confirmUid: z.string().trim().min(1) }),
          response: {
            200: z.object({
              nicknames: z.number().int(),
              ipSeen: z.number().int(),
              notes: z.number().int(),
              flags: z.number().int(),
            }),
          },
        },
      },
      (request) => {
        const { id } = request.params;
        request.audit({ action: 'privacy.anonymize', targetType: 'user', targetId: id });
        const user = getUserById(db, id);
        if (!user) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
        if (user.uid !== request.body.confirmUid) {
          throw new ApiError(400, 'UID_MISMATCH', 'The typed UID does not match this player');
        }
        try {
          return anonymizeUser(
            context.database,
            id,
            context.now(),
            (context.live?.clidsOf?.(id) ?? []).length > 0,
          );
        } catch (error) {
          if (error instanceof AnonymizeError) {
            const [status, message] = ERRORS[error.code];
            throw new ApiError(status, error.code, message);
          }
          throw error;
        }
      },
    );
    return Promise.resolve();
  };
}
