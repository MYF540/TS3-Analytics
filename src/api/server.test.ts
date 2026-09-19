import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { AppDatabase } from '../db/client.js';
import { createTestDatabase } from '../db/testing.js';
import type { ConnectionState } from '../ts3/connection.js';
import type { ApiContext } from './context.js';
import { ApiError } from './errors.js';
import { buildServer, startServer } from './server.js';
import { createTestContext, sessionCookie } from './testing.js';

let database: AppDatabase;
let context: ApiContext & { ts3: { state: ConnectionState } };
let app: FastifyInstance | undefined;
let webRoot: string | undefined;
let cookie: string;

beforeEach(() => {
  database = createTestDatabase();
  context = {
    ...createTestContext(database, { now: () => 1_000_100, startedAt: 1_000_000 }),
    ts3: { state: 'connected' },
  };
  cookie = sessionCookie(context);
});

afterEach(async () => {
  await app?.close();
  app = undefined;
  if (database.sqlite.open) database.close();
  if (webRoot) rmSync(webRoot, { recursive: true, force: true });
  webRoot = undefined;
});

describe('GET /api/health', () => {
  it('reports database and query connection', async () => {
    app = await buildServer(context);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: 'ok',
      uptimeS: 100,
      db: { ok: true },
      ts3: { state: 'connected', connected: true },
    });
  });

  it('is degraded without a query connection', async () => {
    context.ts3.state = 'waiting';
    app = await buildServer(context);
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'degraded', ts3: { connected: false } });
  });

  it('answers 503 when the database is unavailable', async () => {
    app = await buildServer(context);
    database.close();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ status: 'down', db: { ok: false } });
  });
});

describe('error format', () => {
  const testRoutes: FastifyPluginAsyncZod = (api) => {
    api.get(
      '/api/test/validate',
      { schema: { querystring: z.object({ page: z.coerce.number().int().min(1) }) } },
      (request) => ({ page: request.query.page }),
    );
    api.get('/api/test/forbidden', () => {
      throw new ApiError(403, 'FORBIDDEN', 'Not allowed');
    });
    api.get('/api/test/crash', () => {
      throw new Error('SQLITE_ERROR: no such table secret_internal_table');
    });
    return Promise.resolve();
  };

  beforeEach(async () => {
    app = await buildServer(context);
    await app.register(testRoutes);
  });

  it('returns validation errors with details', async () => {
    const res = await app?.inject({
      method: 'GET',
      url: '/api/test/validate?page=0',
      headers: { cookie },
    });
    expect(res?.statusCode).toBe(400);
    expect(res?.json()).toEqual({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: [expect.objectContaining({ location: 'querystring', path: '/page' })],
      },
    });
  });

  it('passes expected errors through', async () => {
    const res = await app?.inject({
      method: 'GET',
      url: '/api/test/forbidden',
      headers: { cookie },
    });
    expect(res?.statusCode).toBe(403);
    expect(res?.json()).toEqual({ error: { code: 'FORBIDDEN', message: 'Not allowed' } });
  });

  it('hides internals of unexpected errors', async () => {
    const res = await app?.inject({ method: 'GET', url: '/api/test/crash', headers: { cookie } });
    expect(res?.statusCode).toBe(500);
    expect(res?.json()).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Internal server error' },
    });
    expect(res?.body).not.toContain('secret_internal_table');
  });

  it('answers unknown API routes with a JSON 404', async () => {
    const res = await app?.inject({
      method: 'GET',
      url: '/api/does-not-exist',
      headers: { cookie },
    });
    expect(res?.statusCode).toBe(404);
    expect(res?.json()).toEqual({ error: { code: 'NOT_FOUND', message: 'Route not found' } });
  });

  it('does not reveal API routes to anonymous visitors', async () => {
    const res = await app?.inject({ method: 'GET', url: '/api/does-not-exist' });
    expect(res?.statusCode).toBe(401);
  });

  it('sets security headers', async () => {
    const res = await app?.inject({ method: 'GET', url: '/api/health' });
    expect(res?.headers['x-content-type-options']).toBe('nosniff');
    expect(res?.headers['x-frame-options']).toBe('DENY');
  });
});

describe('frontend', () => {
  beforeEach(async () => {
    webRoot = mkdtempSync(join(tmpdir(), 'ts3-web-'));
    mkdirSync(join(webRoot, 'assets'));
    writeFileSync(join(webRoot, 'index.html'), '<!doctype html><div id="root"></div>');
    writeFileSync(join(webRoot, 'assets', 'app.js'), 'console.log(1)');
    app = await buildServer(context, { webRoot });
  });

  it('serves index.html and assets', async () => {
    const index = await app?.inject({ method: 'GET', url: '/' });
    expect(index?.statusCode).toBe(200);
    expect(index?.body).toContain('id="root"');
    const asset = await app?.inject({ method: 'GET', url: '/assets/app.js' });
    expect(asset?.statusCode).toBe(200);
    expect(asset?.headers['content-type']).toContain('javascript');
  });

  it('falls back to index.html for client-side routes but not for the API', async () => {
    const page = await app?.inject({ method: 'GET', url: '/spieler/42' });
    expect(page?.statusCode).toBe(200);
    expect(page?.headers['content-type']).toContain('text/html');
    const api = await app?.inject({ method: 'GET', url: '/api/nope' });
    expect(api?.statusCode).toBe(401); // JSON error, not the SPA
    expect(api?.headers['content-type']).toContain('application/json');
  });

  it('does not serve files outside the web root', async () => {
    const res = await app?.inject({ method: 'GET', url: '/../package.json' });
    expect(res?.body).not.toContain('"name": "ts3-analytics"');
  });
});

describe('startServer', () => {
  it('listens on the loopback address', async () => {
    app = await startServer(
      context,
      { host: '127.0.0.1', port: 0, sessionTtlS: 3600, cookieSecure: false },
      { webRoot: undefined },
    );
    const address = app.server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    const res = await fetch(`http://127.0.0.1:${String(address.port)}/api/health`);
    expect(res.status).toBe(200);
  });
});
