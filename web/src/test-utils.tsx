import { render } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { vi } from 'vitest';
import type { Health, Heatmap, OnlineSeries, Overview } from './api/types';
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

type Responder = (url: URL) => { status?: number; body: unknown } | undefined;

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
    '/api/stats/overview': sampleOverview,
    '/api/stats/online': sampleSeries,
    '/api/stats/heatmap': sampleHeatmap,
  };
  const table = { ...defaults, ...overrides };
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = toUrl(input);
    const entry = table[url.pathname];
    const result =
      typeof entry === 'function'
        ? (entry as Responder)(url)
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
