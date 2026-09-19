import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { upsertUser } from '../../db/repositories/index.js';
import { createTestDatabase } from '../../db/testing.js';
import { listAudit } from '../audit/audit.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let userId: number;
const cookies = { viewer: '', moderator: '', otherModerator: '', admin: '' };

beforeEach(async () => {
  database = createTestDatabase();
  userId = upsertUser(database.db, { uid: 'uid-a=', seenAt: 1_700_000_000 });
  context = createTestContext(database);
  cookies.viewer = sessionCookie(context, 'viewer');
  cookies.moderator = sessionCookie(context, 'moderator');
  cookies.otherModerator = sessionCookie(context, 'moderator');
  cookies.admin = sessionCookie(context, 'admin');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
});

function call(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT',
  url: string,
  cookie: string,
  payload?: object,
) {
  return app.inject({
    method,
    url: `/api${url}`,
    headers: { cookie },
    ...(payload ? { payload } : {}),
  });
}

async function addNote(body = 'Hilft neuen Spielern') {
  const res = await call('POST', `/users/${String(userId)}/notes`, cookies.moderator, { body });
  expect(res.statusCode).toBe(201);
  return res.json<{ id: number }>().id;
}

describe('notes', () => {
  it('lets moderators add notes and viewers read them', async () => {
    await addNote('  Erste Notiz  ');
    const res = await call('GET', `/users/${String(userId)}/notes`, cookies.viewer);
    expect(res.statusCode).toBe(200);
    const { notes } = res.json<{
      notes: { body: string; editable: boolean; revisions: number }[];
    }>();
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ body: 'Erste Notiz', editable: false, revisions: 0 });
  });

  it('rejects notes from viewers, empty notes and unknown players', async () => {
    const url = `/users/${String(userId)}/notes`;
    expect((await call('POST', url, cookies.viewer, { body: 'x' })).statusCode).toBe(403);
    expect((await call('POST', url, cookies.moderator, { body: '   ' })).statusCode).toBe(400);
    expect(
      (await call('POST', '/users/999/notes', cookies.moderator, { body: 'x' })).statusCode,
    ).toBe(404);
  });

  it('keeps the old text as revision on edit and delete', async () => {
    const id = await addNote('v1');
    const edited = await call('PATCH', `/notes/${String(id)}`, cookies.moderator, { body: 'v2' });
    expect(edited.statusCode).toBe(200);
    expect(edited.json()).toMatchObject({ body: 'v2', revisions: 1, editable: true });
    const listed = await call('GET', `/users/${String(userId)}/notes`, cookies.viewer);
    expect(listed.json<{ notes: { revisions: number }[] }>().notes[0]?.revisions).toBe(1);

    const deleted = await call('DELETE', `/notes/${String(id)}`, cookies.moderator);
    expect(deleted.statusCode).toBe(204);
    const list = await call('GET', `/users/${String(userId)}/notes`, cookies.viewer);
    expect(list.json<{ notes: unknown[] }>().notes).toHaveLength(0);

    const revisions = database.sqlite
      .prepare('SELECT body FROM player_note_revisions WHERE note_id = ? ORDER BY id')
      .all(id);
    expect(revisions).toEqual([{ body: 'v1' }, { body: 'v2' }]);
  });

  it('allows only the author or an admin to change a note', async () => {
    const id = await addNote();
    const url = `/notes/${String(id)}`;
    const foreign = await call('PATCH', url, cookies.otherModerator, { body: 'fremd' });
    expect(foreign.statusCode).toBe(403);
    expect(foreign.json()).toMatchObject({ error: { code: 'NOT_AUTHOR' } });
    expect((await call('PATCH', url, cookies.admin, { body: 'admin' })).statusCode).toBe(200);

    const revisions = await call('GET', `${url}/revisions`, cookies.viewer);
    expect(revisions.json<{ revisions: { body: string }[] }>().revisions).toEqual([
      expect.objectContaining({ body: 'Hilft neuen Spielern' }),
    ]);
    expect((await call('DELETE', url, cookies.otherModerator)).statusCode).toBe(403);
    expect((await call('DELETE', url, cookies.admin)).statusCode).toBe(204);
    expect((await call('PATCH', url, cookies.admin, { body: 'x' })).statusCode).toBe(404);
  });

  it('audits note changes without the note text', async () => {
    await addNote('Geheimer Inhalt');
    const [entry] = listAudit(database.sqlite, {}, { limit: 10, offset: 0 }).items;
    expect(entry).toMatchObject({
      action: 'note.create',
      targetType: 'user',
      targetId: String(userId),
    });
    expect(JSON.stringify(entry)).not.toContain('Geheimer Inhalt');
  });
});

describe('tags', () => {
  async function addTag(name: string, color = 'blue') {
    const res = await call('POST', '/tags', cookies.moderator, { name, color });
    expect(res.statusCode).toBe(201);
    return res.json<{ id: number }>().id;
  }

  it('creates tags with unique names (case-insensitive)', async () => {
    await addTag('Stammspieler');
    const dup = await call('POST', '/tags', cookies.moderator, {
      name: 'stammspieler',
      color: 'red',
    });
    expect(dup.statusCode).toBe(409);
    expect(
      (await call('POST', '/tags', cookies.moderator, { name: 'x', color: 'pink' })).statusCode,
    ).toBe(400);
  });

  it('assigns tags to players and reports them in the player detail', async () => {
    const a = await addTag('Stammspieler', 'green');
    const b = await addTag('Clan');
    const url = `/users/${String(userId)}/tags`;
    const res = await call('PUT', url, cookies.moderator, { tagIds: [b, a] });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ tags: { name: string }[] }>().tags.map((t) => t.name)).toEqual([
      'Clan',
      'Stammspieler',
    ]);

    await call('PUT', url, cookies.moderator, { tagIds: [a] });
    const detail = await call('GET', `/users/${String(userId)}`, cookies.viewer);
    expect(detail.json<{ tags: unknown[] }>().tags).toEqual([
      { id: a, name: 'Stammspieler', color: 'green' },
    ]);

    const list = await call('GET', '/tags', cookies.viewer);
    expect(list.json<{ tags: { name: string; users: number }[] }>().tags).toEqual([
      expect.objectContaining({ name: 'Clan', users: 0 }),
      expect.objectContaining({ name: 'Stammspieler', users: 1 }),
    ]);
    const audit = listAudit(database.sqlite, {}, { limit: 1, offset: 0 }).items[0];
    expect(audit).toMatchObject({ action: 'user.tags', details: { added: [], removed: [b] } });
  });

  it('rejects unknown tag ids and viewer changes', async () => {
    const url = `/users/${String(userId)}/tags`;
    expect((await call('PUT', url, cookies.moderator, { tagIds: [42] })).statusCode).toBe(400);
    expect((await call('PUT', url, cookies.viewer, { tagIds: [] })).statusCode).toBe(403);
  });

  it('lets only admins rename and delete tags', async () => {
    const a = await addTag('Clan');
    const b = await addTag('Gast');
    await call('PUT', `/users/${String(userId)}/tags`, cookies.moderator, { tagIds: [a] });
    const url = `/tags/${String(a)}`;
    expect((await call('PATCH', url, cookies.moderator, { name: 'Clan X' })).statusCode).toBe(403);
    expect((await call('PATCH', url, cookies.admin, { name: 'gast' })).statusCode).toBe(409);
    const renamed = await call('PATCH', url, cookies.admin, { name: 'Clan X', color: 'purple' });
    expect(renamed.json()).toEqual({ id: a, name: 'Clan X', color: 'purple' });
    expect(
      (await call('PATCH', `/tags/${String(b)}`, cookies.admin, { name: 'Gast' })).statusCode,
    ).toBe(200);

    expect((await call('DELETE', url, cookies.moderator)).statusCode).toBe(403);
    expect((await call('DELETE', url, cookies.admin)).statusCode).toBe(204);
    const detail = await call('GET', `/users/${String(userId)}`, cookies.viewer);
    expect(detail.json<{ tags: unknown[] }>().tags).toEqual([]);
    expect((await call('DELETE', url, cookies.admin)).statusCode).toBe(404);
  });
});
