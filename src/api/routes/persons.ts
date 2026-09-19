import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getPersonOfUser,
  getUserById,
  linkUsers,
  PersonLinkError,
  setPrimaryUser,
  unlinkUser,
} from '../../db/repositories/index.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

const params = z.object({ id: z.coerce.number().int().positive() });

const personResponse = z.object({
  person: z
    .object({
      id: z.number().int(),
      primaryUserId: z.number().int(),
      members: z.array(
        z.object({
          userId: z.number().int(),
          uid: z.string(),
          nickname: z.string().nullable(),
          addedAt: z.number().int(),
          addedBy: z.string(),
        }),
      ),
    })
    .nullable(),
});

const ERRORS: Record<PersonLinkError['code'], [number, string, string]> = {
  SAME_USER: [400, 'SAME_USER', 'A user cannot be linked with itself'],
  NOT_LINKED: [409, 'NOT_LINKED', 'The user is not linked to anyone'],
  NOT_A_MEMBER: [409, 'NOT_LINKED', 'The user is not linked to anyone'],
};

/** UID linking (T5.3) for moderators and admins; every change is audited. */
export function personRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { sqlite, db } = context.database;

    const run = (action: () => void) => {
      try {
        sqlite.transaction(action)();
      } catch (error) {
        if (error instanceof PersonLinkError) {
          const [status, code, message] = ERRORS[error.code];
          throw new ApiError(status, code, message);
        }
        throw error;
      }
    };
    const requireUser = (id: number) => {
      if (!getUserById(db, id)) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
    };
    const person = (id: number) => ({ person: getPersonOfUser(sqlite, id) ?? null });

    app.post(
      '/users/:id/links',
      {
        config: { auth: 'moderator' },
        schema: {
          params,
          body: z.object({ userId: z.number().int().positive() }),
          response: { 200: personResponse },
        },
      },
      (request) => {
        const { id } = request.params;
        const other = request.body.userId;
        request.audit({
          action: 'person.link',
          targetType: 'user',
          targetId: id,
          details: { userId: other },
        });
        requireUser(id);
        requireUser(other);
        run(() => {
          linkUsers(sqlite, id, other, request.user?.username ?? 'unknown', context.now());
        });
        return person(id);
      },
    );

    app.delete(
      '/users/:id/links',
      { config: { auth: 'moderator' }, schema: { params, response: { 200: personResponse } } },
      (request) => {
        const { id } = request.params;
        request.audit({ action: 'person.unlink', targetType: 'user', targetId: id });
        requireUser(id);
        run(() => {
          unlinkUser(sqlite, id);
        });
        return person(id);
      },
    );

    app.post(
      '/users/:id/primary',
      { config: { auth: 'moderator' }, schema: { params, response: { 200: personResponse } } },
      (request) => {
        const { id } = request.params;
        request.audit({ action: 'person.primary', targetType: 'user', targetId: id });
        requireUser(id);
        run(() => {
          setPrimaryUser(sqlite, id);
        });
        return person(id);
      },
    );
    return Promise.resolve();
  };
}
