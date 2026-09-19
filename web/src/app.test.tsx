import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, api, buildUrl } from './api/client';
import { errorMessage, formatDay, formatDuration, t } from './i18n';
import { mockApi, renderAt } from './test-utils';

beforeEach(() => {
  mockApi();
});

afterEach(() => {
  delete document.documentElement.dataset.theme;
});

describe('routing', () => {
  it.each([
    ['/', 'Dashboard'],
    ['/spieler', 'Spieler'],
    ['/spieler/1', 'Alice'],
    ['/leaderboards', 'Leaderboards'],
    ['/gibt-es-nicht', 'Seite nicht gefunden'],
  ])('renders %s', async (path, heading) => {
    renderAt(path);
    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeInTheDocument();
  });

  it('navigates via the main navigation and marks the active link', async () => {
    const router = renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    await userEvent.click(within(nav).getByRole('link', { name: 'Leaderboards' }));
    expect(router.state.location.pathname).toBe('/leaderboards');
    expect(within(nav).getByRole('link', { name: 'Leaderboards' })).toHaveClass('active');
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).not.toHaveClass('active');
  });

  it('shows the TeamSpeak connection status from /api/health', async () => {
    renderAt('/');
    expect(await screen.findByText('Mit TeamSpeak verbunden')).toBeInTheDocument();
  });

  it('shows when the service is unreachable', async () => {
    mockApi({ '/api/health': () => ({ status: 502, body: {} }) });
    renderAt('/');
    expect(await screen.findByText('Dienst nicht erreichbar')).toBeInTheDocument();
  });
});

describe('theme', () => {
  it('toggles between light and dark and remembers the choice', async () => {
    renderAt('/');
    const initial = document.documentElement.dataset.theme;
    await userEvent.click(await screen.findByRole('button', { name: 'Farbschema wechseln' }));
    const toggled = document.documentElement.dataset.theme;
    expect(toggled).not.toBe(initial);
    expect(localStorage.getItem('ts3-analytics.theme')).toBe(toggled);
  });
});

describe('api client', () => {
  it('builds URLs with query parameters and skips empty ones', () => {
    expect(
      buildUrl('/users', { search: 'a b', page: 2, sort: undefined, includeCasual: true }),
    ).toBe('/api/users?search=a+b&page=2&includeCasual=true');
  });

  it('translates API error codes', async () => {
    mockApi({
      '/api/users/9': () => ({
        status: 404,
        body: { error: { code: 'USER_NOT_FOUND', message: 'User not found' } },
      }),
    });
    await expect(api.user(9)).rejects.toMatchObject({
      status: 404,
      code: 'USER_NOT_FOUND',
      message: 'Dieser Spieler existiert nicht.',
    });
  });

  it('reports network errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );
    await expect(api.overview('30d')).rejects.toBeInstanceOf(ApiRequestError);
    await expect(api.overview('30d')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('i18n', () => {
  it('formats values for German users', () => {
    expect(t('page.player.intro', { id: 7 })).toBe('Details zu Spieler #7.');
    expect(errorMessage('SOMETHING_NEW')).toBe('Unbekannter Fehler.');
    expect(formatDuration(59)).toBe('0 min');
    expect(formatDuration(3 * 3600 + 5 * 60)).toBe('3 h 5 min');
    expect(formatDuration(1234 * 3600)).toBe('1.234 h');
    expect(formatDuration(150 * 3600 + 59 * 60)).toBe('150 h');
    expect(formatDuration(99 * 3600 + 59 * 60)).toBe('99 h 59 min');
    expect(formatDay(20260919)).toBe('19.09.2026');
  });
});
