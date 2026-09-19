import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAlertSettings } from '../../alerts/settings.js';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import type { ApiContext } from '../context.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const WEBHOOK = 'https://discord.com/api/webhooks/987654/Very-Secret_Token1234';

let database: AppDatabase;
let context: ApiContext;
let app: FastifyInstance;
let admin: string;

beforeEach(async () => {
  database = createTestDatabase();
  context = createTestContext(database);
  admin = sessionCookie(context, 'admin');
  app = await buildServer(context);
});

afterEach(async () => {
  await app.close();
  database.close();
  vi.unstubAllGlobals();
});

function put(payload: object, cookie = admin) {
  return app.inject({ method: 'PUT', url: '/api/settings/alerts', headers: { cookie }, payload });
}

describe('alert settings API', () => {
  it('stores the webhook but only ever returns a masked hint', async () => {
    const res = await put({
      webhookUrl: WEBHOOK,
      events: ['flag.high', 'ban.added'],
      ratePerMinute: 5,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      configured: true,
      webhookHint: '…1234',
      events: ['flag.high', 'ban.added'],
      ratePerMinute: 5,
    });
    expect(loadAlertSettings(database.db).webhookUrl).toBe(WEBHOOK);

    const get = await app.inject({ url: '/api/settings/alerts', headers: { cookie: admin } });
    expect(get.body).not.toContain('Very-Secret');
    const audit = JSON.stringify(database.sqlite.prepare('SELECT * FROM audit_log').all());
    expect(audit).not.toContain('Very-Secret');
    const details = database.sqlite
      .prepare('SELECT details FROM audit_log')
      .pluck()
      .get() as string;
    expect(JSON.parse(details)).toMatchObject({ webhook: 'set' });
  });

  it('keeps the webhook when omitted and removes it with null', async () => {
    await put({ webhookUrl: WEBHOOK, events: [], ratePerMinute: 10 });
    const kept = await put({ events: ['bot.connection'], ratePerMinute: 10 });
    expect(kept.json()).toMatchObject({ configured: true, events: ['bot.connection'] });
    const removed = await put({ webhookUrl: null, events: [], ratePerMinute: 10 });
    expect(removed.json()).toMatchObject({ configured: false, webhookHint: null });
  });

  it('only accepts Discord webhook URLs', async () => {
    for (const webhookUrl of [
      'https://example.com/api/webhooks/1/x',
      'http://discord.com/api/webhooks/1/x',
      'https://discord.com/api/webhooks/abc/x',
    ]) {
      const res = await put({ webhookUrl, events: [], ratePerMinute: 10 });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ error: { code: 'INVALID_WEBHOOK' } });
    }
    expect(loadAlertSettings(database.db).webhookUrl).toBeNull();
  });

  it('sends a test message', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal('fetch', fetchMock);
    const none = await app.inject({
      method: 'POST',
      url: '/api/settings/alerts/test',
      headers: { cookie: admin },
    });
    expect(none.statusCode).toBe(409);
    await put({ webhookUrl: WEBHOOK, events: [], ratePerMinute: 10 });
    const res = await app.inject({
      method: 'POST',
      url: '/api/settings/alerts/test',
      headers: { cookie: admin },
    });
    expect(res.json()).toEqual({ ok: true, status: null });
    expect(fetchMock).toHaveBeenCalledWith(WEBHOOK, expect.objectContaining({ method: 'POST' }));
  });

  it('is admin-only', async () => {
    const moderator = sessionCookie(context, 'moderator');
    expect((await put({ events: [], ratePerMinute: 10 }, moderator)).statusCode).toBe(403);
  });
});
