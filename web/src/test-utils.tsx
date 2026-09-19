import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type {
  Health,
  Heatmap,
  OnlineSeries,
  Overview,
  Paged,
  UserDetail,
  UserListItem,
} from './api/types';
import { routes } from './routes';

export const sampleHealth: Health = {
  status: 'ok',
  uptimeS: 1,
  db: { ok: true, latencyMs: 0.1 },
  ts3: { state: 'connected', connected: true },
};

export const sampleOverview: Overview = {
  range: '24h',
  onlineNow: 12,
  peakToday: 30,
  peakInRange: 41,
  peakAllTime: 87,
  usersTotal: 8512,
  usersNew: 5,
};

export const sampleSeries: OnlineSeries = {
  from: 1_789_800_000,
  to: 1_789_800_900,
  resolution: 300,
  points: [
    { t: 1_789_800_000, avgOnline: 10.25, maxOnline: 12 },
    { t: 1_789_800_300, avgOnline: 11, maxOnline: 13 },
    { t: 1_789_800_600, avgOnline: 9.5, maxOnline: 11 },
  ],
};

export const sampleHeatmap: Heatmap = {
  range: '30d',
  values: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, (_, h) => d + h / 10)),
};

export const sampleUsers: Paged<UserListItem> = {
  items: [
    {
      userId: 1,
      uid: 'uid-alice=',
      nickname: 'Alice',
      onlineS: 90_000,
      activeS: 60_000,
      sessions: 42,
      firstSeen: 1_700_000_000,
      lastSeen: 1_789_800_000,
      country: 'DE',
      online: true,
    },
    {
      userId: 2,
      uid: 'uid-bob=',
      nickname: null,
      onlineS: 7200,
      activeS: 3600,
      sessions: 3,
      firstSeen: 1_750_000_000,
      lastSeen: 1_780_000_000,
      country: null,
      online: false,
    },
  ],
  total: 120,
  page: 1,
  pageSize: 50,
};

export const sampleUser: UserDetail = {
  user: {
    id: 1,
    uid: 'uid-alice=',
    dbid: 17,
    nickname: 'Alice',
    firstSeen: 1_700_000_000,
    lastSeen: 1_789_800_000,
    platform: 'Windows',
    version: '3.6.2',
    country: 'DE',
  },
  online: { since: 1_789_790_000 },
  totals: { onlineS: 90_000, activeS: 60_000, sessions: 42, longestSessionS: 18_000 },
  nicknames: [
    { nick: 'Alice', firstSeen: 1_760_000_000, lastSeen: 1_789_800_000 },
    { nick: 'Al1ce', firstSeen: 1_700_000_000, lastSeen: 1_759_000_000 },
  ],
  recentSessions: [
    { id: 9, joinAt: 1_789_790_000, leaveAt: null, duration: null, source: 'live' },
    { id: 8, joinAt: 1_600_000_000, leaveAt: 1_600_003_600, duration: 3600, source: 'import' },
  ],
  daily: [
    {
      day: 20260918,
      onlineS: 7200,
      activeS: 3600,
      idleS: 1800,
      afkS: 1800,
      unknownS: 0,
      sessions: 1,
    },
  ],
  topChannels: [
    { channelId: 3, name: 'Gaming', seconds: 50_000 },
    { channelId: null, name: null, seconds: 10_000 },
  ],
  countries: [{ country: 'DE', lastSeen: 1_789_790_000, connections: 12 }],
};

type Responder = (url: URL, init?: RequestInit) => { status?: number; body: unknown } | undefined;

function toUrl(input: RequestInfo | URL): URL {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  return new URL(href, 'http://localhost');
}

/**
 * Replaces `fetch` with a router over API paths. Unknown paths answer 404 in the API error
 * format. Returns the mock so tests can inspect the requested URLs.
 */
export function mockApi(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    '/api/health': sampleHealth,
    '/api/auth/me': { user: { id: 1, username: 'admin', role: 'admin' } },
    '/api/auth/logout': () => ({ status: 204, body: null }),
    '/api/stats/overview': sampleOverview,
    '/api/stats/online': sampleSeries,
    '/api/stats/heatmap': sampleHeatmap,
    '/api/online': {
      connected: true,
      items: [
        {
          userId: 1,
          nickname: 'Alice',
          channelId: 3,
          channelName: 'Gaming',
          state: 'active',
          since: 1_789_790_000,
        },
        {
          userId: 2,
          nickname: 'Bob',
          channelId: 9,
          channelName: 'AFK',
          state: 'afk',
          since: 1_789_780_000,
        },
      ],
    },
    '/api/users': sampleUsers,
    '/api/users/1': sampleUser,
  };
  const table = { ...defaults, ...overrides };
  const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    const url = toUrl(input);
    const entry = table[url.pathname];
    const result =
      typeof entry === 'function'
        ? (entry as Responder)(url, init)
        : entry === undefined
          ? undefined
          : { body: entry };
    const { status, body } = result ?? {
      status: 404,
      body: { error: { code: 'NOT_FOUND', message: 'Route not found' } },
    };
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: status ?? 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** URLs requested so far for a path, e.g. to check query parameters. */
export function requested(fetchMock: ReturnType<typeof mockApi>, path: string): URL[] {
  return fetchMock.mock.calls.map(([input]) => toUrl(input)).filter((url) => url.pathname === path);
}

export function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return router;
}
