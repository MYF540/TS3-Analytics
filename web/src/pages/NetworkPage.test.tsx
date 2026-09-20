import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { NetworkGraph } from '../api/types';
import { mockApi, renderAt, requested } from '../test-utils';

const H = 3600;

const graph: NetworkGraph = {
  range: '30d',
  computedAt: 1_789_800_000,
  from: 1_787_208_000,
  to: 1_789_800_000,
  nodes: [
    { userId: 1, nickname: 'Alice', seconds: 40 * H, accounts: 1 },
    { userId: 2, nickname: 'Bob', seconds: 30 * H, accounts: 2 },
    { userId: 3, nickname: null, seconds: 10 * H, accounts: 1 },
  ],
  edges: [
    { a: 1, b: 2, seconds: 20 * H, encounters: 12, shareA: 0.5, shareB: 0.67 },
    { a: 1, b: 3, seconds: 5 * H, encounters: 3, shareA: 0.125, shareB: 0.5 },
  ],
  edgesTotal: 480,
  strongestS: 20 * H,
};

describe('NetworkPage', () => {
  it('draws the graph and says what it shows', async () => {
    mockApi({ '/api/network': graph });
    renderAt('/netzwerk');
    const chart = await screen.findByRole('img', { name: /Netzwerkdiagramm/ });
    const option = JSON.parse(chart.dataset.option ?? '{}') as {
      series: { data: { id: string; symbolSize: number }[]; links: { source: string }[] }[];
    };
    expect(option.series[0]?.data.map((node) => node.id)).toEqual(['1', '2', '3']);
    expect(option.series[0]?.links).toHaveLength(2);
    // The busiest player gets the biggest dot.
    const sizes = option.series[0]?.data.map((node) => node.symbolSize) ?? [];
    expect(sizes[0]).toBeGreaterThan(sizes[2] as number);
    expect(screen.getByText(/3 Spieler, 2 von 480 Verbindungen gezeigt/)).toBeInTheDocument();
    expect(screen.getByText(/Berechnet am/)).toBeInTheDocument();
  });

  it('lists the strongest pairs as a table', async () => {
    mockApi({ '/api/network': graph });
    renderAt('/netzwerk');
    await userEvent.click(await screen.findByText('Stärkste Paare als Tabelle anzeigen'));
    const row = screen.getByRole('row', { name: /Alice.*Bob/ });
    expect(
      within(row)
        .getAllByRole('cell')
        .map((cell) => cell.textContent),
    ).toEqual(['20 h', '12', '50 % / 67 %']);
    expect(within(row).getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/spieler/1');
  });

  it('asks for fewer or more connections when the slider moves', async () => {
    const fetchMock = mockApi({ '/api/network': graph });
    renderAt('/netzwerk');
    await screen.findByRole('img', { name: /Netzwerkdiagramm/ });
    const slider = screen.getByRole('slider', { name: /Gezeigte Verbindungen/ });
    expect(slider).toHaveValue('3');
    // A range input reacts to a change event; arrow keys do not move it in jsdom.
    fireEvent.change(slider, { target: { value: '4' } });
    await waitFor(() => {
      expect(
        requested(fetchMock, '/api/network').map((url) => url.searchParams.get('limit')),
      ).toEqual(['200', '400']);
    });
    expect(screen.getByText(/Gezeigte Verbindungen: 400/)).toBeInTheDocument();
  });

  it('switches the window and keeps it in the URL', async () => {
    const fetchMock = mockApi({ '/api/network': graph });
    const router = renderAt('/netzwerk');
    await screen.findByRole('img', { name: /Netzwerkdiagramm/ });
    await userEvent.click(screen.getByRole('radio', { name: '90 Tage' }));
    await waitFor(() => {
      expect(
        requested(fetchMock, '/api/network').map((url) => url.searchParams.get('range')),
      ).toContain('90d');
    });
    expect(router.state.location.search).toBe('?zeitraum=90d');
  });

  it('recomputes the network on demand', async () => {
    const fetchMock = mockApi({
      '/api/network': graph,
      '/api/settings/network/run': { state: null },
    });
    renderAt('/netzwerk');
    await screen.findByRole('img', { name: /Netzwerkdiagramm/ });
    await userEvent.click(screen.getByRole('button', { name: 'Jetzt neu berechnen' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => (input as string).includes('/settings/network/run')),
      ).toBe(true);
    });
    // The graph is fetched again afterwards.
    await waitFor(() => {
      expect(requested(fetchMock, '/api/network').length).toBeGreaterThan(1);
    });
  });

  it('explains an empty network', async () => {
    mockApi({
      '/api/network': { ...graph, computedAt: null, nodes: [], edges: [], edgesTotal: 0 },
    });
    renderAt('/netzwerk');
    expect(
      await screen.findByText(/Für diesen Zeitraum gibt es keine Verbindungen/),
    ).toBeInTheDocument();
    expect(screen.getByText('Das Netz wurde noch nicht berechnet.')).toBeInTheDocument();
  });

  it('stays hidden from moderators', async () => {
    mockApi({ '/api/auth/me': { user: { id: 3, username: 'mod', role: 'moderator' } } });
    renderAt('/netzwerk');
    expect(await screen.findByText('Keine Berechtigung')).toBeInTheDocument();
  });
});
