import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Leaderboard } from '../api/types';
import { mockApi, renderAt, requested } from '../test-utils';

function board(url: URL): { body: Leaderboard } {
  const period = (url.searchParams.get('period') ?? 'all') as Leaderboard['period'];
  const metric = (url.searchParams.get('metric') ?? 'online') as Leaderboard['metric'];
  return {
    body: {
      period,
      metric,
      fromDay: period === 'all' ? null : 20260913,
      toDay: period === 'all' ? null : 20260919,
      items: [
        { rank: 1, userId: 1, uid: 'a', nickname: 'Alice', value: 36_000, accounts: 2 },
        { rank: 2, userId: 2, uid: 'b', nickname: 'Bob', value: 18_000, accounts: 1 },
        { rank: 4, userId: 4, uid: 'd', nickname: null, value: 600, accounts: 1 },
      ],
      total: 60,
      page: Number(url.searchParams.get('page') ?? 1),
      pageSize: 25,
    },
  };
}

const last = (fetchMock: ReturnType<typeof mockApi>) =>
  Object.fromEntries(requested(fetchMock, '/api/leaderboards').at(-1)?.searchParams ?? []);

describe('LeaderboardsPage', () => {
  it('shows the all-time ranking with links to the players', async () => {
    const fetchMock = mockApi({ '/api/leaderboards': board });
    renderAt('/leaderboards');
    const alice = await screen.findByRole('link', { name: 'Alice' });
    expect(alice).toHaveAttribute('href', '/spieler/1');
    expect(last(fetchMock)).toMatchObject({ period: 'all', metric: 'online' });
    const row = alice.closest('tr');
    if (!row) throw new Error('row missing');
    expect(within(row).getByText('10 h')).toBeInTheDocument();
    expect(row).toHaveClass('is-podium');
    expect(screen.getByRole('tab', { name: 'Gesamt' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Seite 1 von 3')).toBeInTheDocument();
  });

  it('switches between the leaderboard kinds', async () => {
    const fetchMock = mockApi({ '/api/leaderboards': board });
    const router = renderAt('/leaderboards');
    await screen.findByRole('link', { name: 'Alice' });

    await userEvent.click(screen.getByRole('tab', { name: 'Aktiv' }));
    await waitFor(() => {
      expect(last(fetchMock)).toMatchObject({ period: 'all', metric: 'active' });
    });
    expect(screen.getByText(/erst ab Beginn der Live-Erfassung/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Längste Session' }));
    await waitFor(() => {
      expect(last(fetchMock)).toMatchObject({ metric: 'longestSession' });
    });

    await userEvent.click(screen.getByRole('tab', { name: 'Woche' }));
    await waitFor(() => {
      expect(last(fetchMock)).toMatchObject({ period: 'week', metric: 'online' });
    });
    expect(await screen.findByText('Zeitraum: 13.09.2026 – 19.09.2026')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('radio', { name: 'Aktivzeit' }));
    await waitFor(() => {
      expect(last(fetchMock)).toMatchObject({ period: 'week', metric: 'active' });
    });
    expect(router.state.location.search).toBe('?art=woche&wertung=aktiv');
  });

  it('asks for dates in the custom tab and then loads that range', async () => {
    const fetchMock = mockApi({ '/api/leaderboards': board });
    renderAt('/leaderboards?art=zeitraum');
    expect(await screen.findByText('Bitte Start- und Enddatum wählen.')).toBeInTheDocument();
    expect(requested(fetchMock, '/api/leaderboards')).toHaveLength(0);

    renderAt('/leaderboards?art=zeitraum&von=2026-09-01&bis=2026-09-15');
    await waitFor(() => {
      expect(last(fetchMock)).toMatchObject({
        period: 'custom',
        from: '2026-09-01',
        to: '2026-09-15',
      });
    });
  });

  it('offers a CSV export of the current selection', async () => {
    mockApi({ '/api/leaderboards': board });
    renderAt('/leaderboards?art=woche&wertung=aktiv');
    const link = await screen.findByRole('link', { name: 'Als CSV exportieren' });
    expect(link).toHaveAttribute('href', '/api/leaderboards/export.csv?period=week&metric=active');
  });

  it('pages through the ranking', async () => {
    const fetchMock = mockApi({ '/api/leaderboards': board });
    renderAt('/leaderboards');
    await screen.findByRole('link', { name: 'Alice' });
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => {
      expect(last(fetchMock)).toMatchObject({ page: '2' });
    });
  });

  it('explains an empty ranking', async () => {
    mockApi({
      '/api/leaderboards': (url: URL) => {
        const { body } = board(url);
        return { body: { ...body, items: [], total: 0 } };
      },
    });
    renderAt('/leaderboards');
    expect(
      await screen.findByText('Für diese Auswahl gibt es noch keine Einträge.'),
    ).toBeInTheDocument();
  });
});
