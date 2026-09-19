import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createNote,
  createTag,
  deleteNote,
  deleteTag,
  findTagByName,
  getNote,
  getTag,
  getUserById,
  getUserTags,
  listNotes,
  listRevisions,
  listTags,
  setUserTags,
  updateNote,
  updateTag,
  type Note,
} from '../../db/repositories/index.js';
import { TAG_COLORS } from '../../db/schema.js';
import type { AuthUser } from '../auth/service.js';
import type { ApiContext } from '../context.js';
import { ApiError } from '../errors.js';

export const note = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  authorName: z.string(),
  body: z.string(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  revisions: z.number().int(),
  /** Whether the current user may edit or delete this note. */
  editable: z.boolean(),
});

export const tag = z.object({ id: z.number().int(), name: z.string(), color: z.enum(TAG_COLORS) });

export const tagWithUsage = tag.extend({ users: z.number().int() });

export const noteRevision = z.object({
  body: z.string(),
  editorName: z.string(),
  replacedAt: z.number().int(),
});

const userParams = z.object({ id: z.coerce.number().int().positive() });
const noteParams = z.object({ noteId: z.coerce.number().int().positive() });
const tagParams = z.object({ tagId: z.coerce.number().int().positive() });
const noteBody = z.object({ body: z.string().trim().min(1).max(5000) });
const tagName = z.string().trim().min(1).max(32);

/** Moderators may change their own notes, admins everyone's. */
function canEdit(user: AuthUser | undefined, n: Note): boolean {
  if (!user) return false;
  return user.role === 'admin' || (user.role === 'moderator' && n.authorId === user.id);
}

function toResponse(n: Note, user: AuthUser | undefined) {
  return {
    id: n.id,
    userId: n.userId,
    authorName: n.authorName,
    body: n.body,
    createdAt: n.createdAt,
    updatedAt: n.updatedAt,
    revisions: n.revisions,
    editable: canEdit(user, n),
  };
}

/**
 * Notes and tags on the player page. Reading: viewer. Writing notes, creating and assigning
 * tags: moderator. Renaming/deleting tags: admin. The audit log records ids, never note texts.
 */
export function noteRoutes(context: ApiContext): FastifyPluginAsyncZod {
  return (app) => {
    const { db } = context.database;

    const requireUser = (id: number) => {
      if (!getUserById(db, id)) throw new ApiError(404, 'USER_NOT_FOUND', 'User not found');
    };
    const requireNote = (noteId: number) => {
      const found = getNote(db, noteId);
      if (!found) throw new ApiError(404, 'NOTE_NOT_FOUND', 'Note not found');
      return found;
    };

    app.get(
      '/users/:id/notes',
      {
        schema: { params: userParams, response: { 200: z.object({ notes: z.array(note) }) } },
      },
      (request) => {
        requireUser(request.params.id);
        return {
          notes: listNotes(db, request.params.id).map((n) => toResponse(n, request.user)),
        };
      },
    );

    app.post(
      '/users/:id/notes',
      {
        config: { auth: 'moderator' },
        schema: { params: userParams, body: noteBody, response: { 201: note } },
      },
      (request, reply) => {
        requireUser(request.params.id);
        const created = createNote(
          db,
          {
            userId: request.params.id,
            authorId: request.user?.id ?? null,
            authorName: request.user?.username ?? 'unknown',
            body: request.body.body,
          },
          context.now(),
        );
        request.audit({
          action: 'note.create',
          targetType: 'user',
          targetId: request.params.id,
          details: { noteId: created.id },
        });
        void reply.status(201);
        return toResponse(created, request.user);
      },
    );

    app.patch(
      '/notes/:noteId',
      {
        config: { auth: 'moderator' },
        schema: { params: noteParams, body: noteBody, response: { 200: note } },
      },
      (request) => {
        const existing = requireNote(request.params.noteId);
        request.audit({
          action: 'note.update',
          targetType: 'user',
          targetId: existing.userId,
          details: { noteId: existing.id },
        });
        if (!canEdit(request.user, existing)) {
          throw new ApiError(403, 'NOT_AUTHOR', 'Only the author or an admin may change this note');
        }
        const updated = updateNote(
          db,
          existing,
          request.body.body,
          request.user?.username ?? 'unknown',
          context.now(),
        );
        return toResponse(updated, request.user);
      },
    );

    app.delete(
      '/notes/:noteId',
      { config: { auth: 'moderator' }, schema: { params: noteParams } },
      (request, reply) => {
        const existing = requireNote(request.params.noteId);
        request.audit({
          action: 'note.delete',
          targetType: 'user',
          targetId: existing.userId,
          details: { noteId: existing.id },
        });
        if (!canEdit(request.user, existing)) {
          throw new ApiError(403, 'NOT_AUTHOR', 'Only the author or an admin may delete this note');
        }
        deleteNote(db, existing, request.user?.username ?? 'unknown', context.now());
        return reply.status(204).send();
      },
    );

    app.get(
      '/notes/:noteId/revisions',
      {
        schema: {
          params: noteParams,
          response: { 200: z.object({ revisions: z.array(noteRevision) }) },
        },
      },
      (request) => {
        requireNote(request.params.noteId);
        return { revisions: listRevisions(db, request.params.noteId) };
      },
    );

    app.get(
      '/tags',
      { schema: { response: { 200: z.object({ tags: z.array(tagWithUsage) }) } } },
      () => ({ tags: listTags(db) }),
    );

    app.post(
      '/tags',
      {
        config: { auth: 'moderator' },
        schema: {
          body: z.object({ name: tagName, color: z.enum(TAG_COLORS).default('gray') }),
          response: { 201: tag },
        },
      },
      (request, reply) => {
        if (findTagByName(db, request.body.name)) {
          throw new ApiError(409, 'TAG_EXISTS', 'A tag with this name already exists');
        }
        const created = createTag(db, request.body.name, request.body.color, context.now());
        request.audit({ action: 'tag.create', targetType: 'tag', targetId: created.id });
        void reply.status(201);
        return created;
      },
    );

    app.patch(
      '/tags/:tagId',
      {
        config: { auth: 'admin' },
        schema: {
          params: tagParams,
          body: z.object({ name: tagName.optional(), color: z.enum(TAG_COLORS).optional() }),
          response: { 200: tag },
        },
      },
      (request) => {
        request.audit({ action: 'tag.update', targetType: 'tag', targetId: request.params.tagId });
        const existing = getTag(db, request.params.tagId);
        if (!existing) throw new ApiError(404, 'TAG_NOT_FOUND', 'Tag not found');
        const other = request.body.name ? findTagByName(db, request.body.name) : undefined;
        if (other && other.id !== request.params.tagId) {
          throw new ApiError(409, 'TAG_EXISTS', 'A tag with this name already exists');
        }
        updateTag(db, request.params.tagId, request.body);
        return {
          ...existing,
          ...(request.body.name === undefined ? {} : { name: request.body.name }),
          ...(request.body.color === undefined ? {} : { color: request.body.color }),
        };
      },
    );

    app.delete(
      '/tags/:tagId',
      { config: { auth: 'admin' }, schema: { params: tagParams } },
      (request, reply) => {
        request.audit({ action: 'tag.delete', targetType: 'tag', targetId: request.params.tagId });
        if (!getTag(db, request.params.tagId)) {
          throw new ApiError(404, 'TAG_NOT_FOUND', 'Tag not found');
        }
        deleteTag(db, request.params.tagId);
        return reply.status(204).send();
      },
    );

    app.put(
      '/users/:id/tags',
      {
        config: { auth: 'moderator' },
        schema: {
          params: userParams,
          body: z.object({ tagIds: z.array(z.number().int().positive()).max(50) }),
          response: { 200: z.object({ tags: z.array(tag) }) },
        },
      },
      (request) => {
        requireUser(request.params.id);
        const unknown = request.body.tagIds.filter((id) => !getTag(db, id));
        if (unknown.length > 0) {
          throw new ApiError(400, 'TAG_NOT_FOUND', 'Unknown tag', { tagIds: unknown });
        }
        const change = context.database.sqlite.transaction(() =>
          setUserTags(
            db,
            request.params.id,
            request.body.tagIds,
            request.user?.username ?? 'unknown',
            context.now(),
          ),
        )();
        request.audit({
          action: 'user.tags',
          targetType: 'user',
          targetId: request.params.id,
          details: change,
        });
        return { tags: getUserTags(db, request.params.id) };
      },
    );
    return Promise.resolve();
  };
}
