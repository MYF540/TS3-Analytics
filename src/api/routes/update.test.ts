import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDatabase } from '../../db/client.js';
import { createTestDatabase } from '../../db/testing.js';
import { createSilentLogger } from '../../logging/logger.js';
import { Updater, type Launcher } from '../../update/updater.js';
import { buildServer } from '../server.js';
import { createTestContext, sessionCookie } from '../testing.js';

const NOW = 1_789_800_000;

let database: AppDatabase;
let app: FastifyInstance;
let admin: string;
let moderator: string;
let root: string;
let tag: string;
let online: boolean;
const launch = vi.fn<Launcher>(() => Promise.resolve());

async function start(withUpdater = true): Promise<void> {
  const updater = new Updater({
    db: database.db,
    logger: createSilentLogger(),
    currentVersion: '1.1.0',
    repo: 'example/app',
    root,
    serviceName: 'ts3-analytics',
    now: () => NOW,
    fetch: () =>
      online
        ? Promise.resolve(Response.json({ tag_name: tag, html_url: 'https://example.invalid/r' }))
        : Promise.reject(new Error('offline')),
    launch,
    platform: 'win32',
  });
  const context = createTestContext(database, withUpdater ? { updater } : {});
  admin = sessionCookie(context, 'admin');
  moderator = sessionCookie(context, 'moderator');
  app = await buildServer(context);
}

beforeEach(() => {
  database = createTestDatabase();
  root = mkdtempSync(join(tmpdir(), 'ts3-update-api-'));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts', 'setup.ps1'), '');
  tag = 'v1.2.0';
  online = true;
  launch.mockClear();
});

afterEach(async () => {
  await app.close();
  database.close();
  rmSync(root, { recursive: true, force: true });
});

const call = (method: 'GET' | 'POST', url: string, cookie = admin) =>
  app.inject({ method, url, headers: { cookie }, ...(method === 'POST' ? { payload: {} } : {}) });

describe('update routes', () => {
  it('report the running version before anything was checked', async () => {
    await start();
    expect((await call('GET', '/api/update')).json()).toEqual({
      enabled: true,
      currentVersion: '1.1.0',
      latest: null,
      updateAvailable: false,
      installBlocker: null,
      lastRun: null,
    });
  });

  it('find a newer release on request', async () => {
    await start();
    const response = await call('POST', '/api/update/check');
    expect(response.json()).toMatchObject({
      latest: { version: '1.2.0', checkedAt: NOW },
      updateAvailable: true,
    });
  });

  it('answer with an error when GitHub cannot be reached', async () => {
    await start();
    online = false;
    const response = await call('POST', '/api/update/check');
    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({ error: { code: 'UPDATE_CHECK_FAILED' } });
  });

  it('start the update for the checked release and write the audit log', async () => {
    await start();
    await call('POST', '/api/update/check');
    expect((await call('POST', '/api/update/install')).statusCode).toBe(200);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch.mock.calls[0]?.[0]).toContain('update -Version v1.2.0 ');
    expect(
      database.sqlite.prepare('SELECT action, details FROM audit_log ORDER BY id DESC').get(),
    ).toEqual({
      action: 'update.install',
      details: JSON.stringify({ from: '1.1.0', to: '1.2.0' }),
    });
  });

  it('refuse to install when there is nothing newer', async () => {
    await start();
    expect((await call('POST', '/api/update/install')).json()).toMatchObject({
      error: { code: 'UPDATE_NOT_AVAILABLE' },
    });
    tag = 'v1.1.0';
    await call('POST', '/api/update/check');
    expect((await call('POST', '/api/update/install')).statusCode).toBe(409);
    expect(launch).not.toHaveBeenCalled();
  });

  it('ignore a version sent along with the request', async () => {
    await start();
    await call('POST', '/api/update/check');
    await app.inject({
      method: 'POST',
      url: '/api/update/install',
      headers: { cookie: admin },
      payload: { version: 'v9.9.9 & calc' },
    });
    expect(launch.mock.calls[0]?.[0]).toContain('-Version v1.2.0 ');
    expect(launch.mock.calls[0]?.[0]).not.toContain('calc');
  });

  it('show the result of the last run', async () => {
    await start();
    mkdirSync(join(root, 'data'));
    writeFileSync(
      join(root, 'data', 'update-status.json'),
      JSON.stringify({ state: 'done', version: 'v1.1.0', at: NOW, message: '' }),
    );
    expect((await call('GET', '/api/update')).json()).toMatchObject({
      lastRun: { state: 'done', version: 'v1.1.0', at: NOW, message: '' },
    });
  });

  it('are for admins only', async () => {
    await start();
    expect((await call('GET', '/api/update', moderator)).statusCode).toBe(403);
    expect((await call('POST', '/api/update/check', moderator)).statusCode).toBe(403);
    expect((await call('POST', '/api/update/install', moderator)).statusCode).toBe(403);
    expect(launch).not.toHaveBeenCalled();
  });

  it('say so when the service runs without the updater', async () => {
    await start(false);
    expect((await call('GET', '/api/update')).json()).toMatchObject({ enabled: false });
    expect((await call('POST', '/api/update/install')).json()).toMatchObject({
      error: { code: 'UPDATE_UNSUPPORTED' },
    });
  });
});
