import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, requested } from '../test-utils';

describe('PlayerPage', () => {
  it('shows the player with key figures, status and UID', async () => {
    mockApi();
    renderAt('/spieler/1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Alice' })).toBeInTheDocument();
    expect(screen.getByText(/^Online seit/)).toBeInTheDocument();
    expect(screen.getByText('uid-alice=')).toBeInTheDocument();
    const kpi = (label: string) =>
      screen.getByText(label).parentElement?.querySelector('dd')?.textContent;
    expect(kpi('Spielzeit gesamt')).toBe('25 h');
    expect(kpi('Längste Session')).toBe('5 h');
    expect(kpi('Sessions')).toBe('42');
  });

  it('shows when the player is usually online and switches the range', async () => {
    const fetchMock = mockApi();
    renderAt('/spieler/1');
    const card = await screen.findByRole('heading', {
      level: 2,
      name: 'Wann ist dieser Spieler online?',
    });
    const section = within(card.closest('section') as HTMLElement);
    expect(await section.findByRole('img', { name: /Heatmap/ })).toBeInTheDocument();
    await userEvent.click(section.getByRole('radio', { name: '30 Tage' }));
    await waitFor(() => {
      expect(
        requested(fetchMock, '/api/users/1/heatmap').map((url) => url.searchParams.get('range')),
      ).toEqual(['1y', '30d']);
    });
  });

  it('writes the share as a percentage in the table view', async () => {
    mockApi({
      '/api/users/1/heatmap': {
        range: '1y',
        values: Array.from({ length: 7 }, (_, d) => Array.from({ length: 24 }, () => d * 10)),
      },
    });
    renderAt('/spieler/1');
    const card = await screen.findByRole('heading', {
      level: 2,
      name: 'Wann ist dieser Spieler online?',
    });
    const section = within(card.closest('section') as HTMLElement);
    await userEvent.click(await section.findByText('Als Tabelle anzeigen'));
    const row = section.getByRole('row', { name: /^Mi/ });
    expect(within(row).getAllByRole('cell')[0]).toHaveTextContent('20 %');
  });

  it('explains a placeholder from the log import (T8.3)', async () => {
    const { sampleUser } = await import('../test-utils');
    mockApi({
      '/api/users/1': { ...sampleUser, user: { ...sampleUser.user, uid: 'unknown-dbid-4711' } },
    });
    renderAt('/spieler/1');
    expect(await screen.findByText(/^Platzhalter aus dem Log-Import/)).toBeInTheDocument();
  });

  it('shows no such note for a normal player', async () => {
    mockApi();
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(screen.queryByText(/^Platzhalter aus dem Log-Import/)).not.toBeInTheDocument();
  });

  it('draws play time per day by state and switches the range', async () => {
    const fetchMock = mockApi();
    renderAt('/spieler/1');
    const chart = await screen.findByRole('img', { name: /Spielzeit pro Tag/ });
    const option = JSON.parse(chart.dataset.option ?? '{}') as {
      series: { name: string; stack: string }[];
    };
    expect(option.series.map((s) => s.name)).toEqual([
      'Aktiv',
      'Inaktiv (idle)',
      'AFK',
      'Unbekannt (Import)',
    ]);
    expect(new Set(option.series.map((s) => s.stack)).size).toBe(1);
    const chartCard = within(chart.closest('section') as HTMLElement);
    await userEvent.click(chartCard.getByRole('radio', { name: '1 Jahr' }));
    await waitFor(() => {
      expect(requested(fetchMock, '/api/users/1').at(-1)?.searchParams.get('days')).toBe('365');
    });
  });

  it('lists sessions, channels, nicknames and countries', async () => {
    mockApi();
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    const section = (title: string) => {
      const heading = screen.getByRole('heading', { level: 2, name: title });
      const card = heading.closest('section');
      if (!card) throw new Error(`section ${title} missing`);
      return within(card);
    };
    expect(section('Letzte Sessions').getByText('läuft')).toBeInTheDocument();
    expect(section('Letzte Sessions').getByText('importiert')).toBeInTheDocument();
    expect(section('Meistgenutzte Channels').getByText('Gaming')).toBeInTheDocument();
    expect(section('Meistgenutzte Channels').getByText('Gelöschter Channel')).toBeInTheDocument();
    expect(section('Nickname-Verlauf').getByText('Al1ce')).toBeInTheDocument();
    expect(section('Länder').getByText('DE')).toBeInTheDocument();
  });

  it('explains unknown players', async () => {
    mockApi({
      '/api/users/5': () => ({
        status: 404,
        body: { error: { code: 'USER_NOT_FOUND', message: 'User not found' } },
      }),
    });
    renderAt('/spieler/5');
    expect(await screen.findByText('Dieser Spieler existiert nicht.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Zur Spielerliste/ })).toBeInTheDocument();
  });

  it('treats invalid ids as not found', async () => {
    mockApi();
    renderAt('/spieler/abc');
    expect(
      await screen.findByRole('heading', { name: 'Seite nicht gefunden' }),
    ).toBeInTheDocument();
  });
});
