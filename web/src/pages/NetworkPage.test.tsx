import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { NetworkGraph } from '../api/types';
import { mockApi, renderAt, requested } from '../test-utils';

const H = 3600;
const NOW = Math.floor(Date.now() / 1000);
const DAY = 86_400;

const node = (
  userId: number,
  nickname: string | null,
  hours: number,
  extra: Partial<NetworkGraph['nodes'][number]> = {},
): NetworkGraph['nodes'][number] => ({
  userId,
  nickname,
  seconds: hours * H,
  accounts: 1,
  community: 0,
  country: 'DE',
  lastSeen: NOW,
  rankId: null,
  serverGroups: [],
  ...extra,
});

const graph: NetworkGraph = {
  range: '30d',
  computedAt: 1_789_800_000,
  from: 1_787_208_000,
  to: 1_789_800_000,
  nodes: [
    node(1, 'Alice', 40, { serverGroups: [7] }),
    node(2, 'Bob', 30, { accounts: 2, community: 1, country: 'US', lastSeen: NOW - 40 * DAY }),
    node(3, null, 10, { serverGroups: [7] }),
  ],
  edges: [
    { a: 1, b: 2, seconds: 20 * H, encounters: 12, shareA: 0.5, shareB: 0.67 },
    { a: 1, b: 3, seconds: 5 * H, encounters: 3, shareA: 0.125, shareB: 0.5 },
  ],
  edgesTotal: 480,
  strongestS: 20 * H,
  ranks: [],
  groups: [{ id: 7, name: 'Mitglied' }],
};

interface GraphOption {
  series: {
    data: { id: string; itemStyle?: { color?: string; borderWidth?: number } }[];
    links: { source: string; target: string }[];
  }[];
}

async function chartOption(): Promise<GraphOption> {
  const chart = await screen.findByRole('img', { name: /Netzwerkdiagramm/ });
  return JSON.parse(chart.dataset.option ?? '{}') as GraphOption;
}

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

  it('colours the players by their group and hides a group from the legend', async () => {
    mockApi({ '/api/network': graph });
    renderAt('/netzwerk');
    const colours = (await chartOption()).series[0]?.data.map((entry) => entry.itemStyle?.color);
    // Alice and the nameless player share group 1, Bob is in group 2.
    expect(colours?.[0]).toBe(colours?.[2]);
    expect(colours?.[0]).not.toBe(colours?.[1]);

    const legend = within(screen.getByRole('group', { name: 'Legende' }));
    expect(legend.getByLabelText(/Kreis 1 \(2\)/)).toBeChecked();
    await userEvent.click(legend.getByLabelText(/Kreis 2/));
    // Bob is gone, and with him the connection to him.
    await waitFor(async () => {
      expect((await chartOption()).series[0]?.data.map((entry) => entry.id)).toEqual(['1', '3']);
    });
    expect(screen.getByText(/Nach den Filtern: 2 Spieler, 1 Verbindungen/)).toBeInTheDocument();
  });

  it('colours by country and by last sighting, keeping the choice in the URL', async () => {
    mockApi({ '/api/network': graph });
    const router = renderAt('/netzwerk');
    await chartOption();
    await userEvent.selectOptions(screen.getByLabelText('Farbe nach'), 'country');
    const legend = within(screen.getByRole('group', { name: 'Legende' }));
    expect(legend.getByLabelText(/DE \(2\)/)).toBeInTheDocument();
    expect(legend.getByLabelText(/US \(1\)/)).toBeInTheDocument();
    expect(router.state.location.search).toBe('?farbe=country');

    await userEvent.selectOptions(screen.getByLabelText('Farbe nach'), 'activity');
    expect(legend.getByLabelText(/in den letzten 7 Tagen \(2\)/)).toBeInTheDocument();
    expect(legend.getByLabelText(/vor mehr als 30 Tagen \(1\)/)).toBeInTheDocument();
  });

  it('shows only the members of a server group', async () => {
    mockApi({ '/api/network': graph });
    renderAt('/netzwerk');
    await chartOption();
    await userEvent.selectOptions(screen.getByLabelText('Nur Servergruppe'), '7');
    await waitFor(async () => {
      const option = await chartOption();
      expect(option.series[0]?.data.map((entry) => entry.id)).toEqual(['1', '3']);
      expect(option.series[0]?.links).toEqual([
        expect.objectContaining({ source: '1', target: '3' }),
      ]);
    });
  });

  it('asks for the surroundings of a searched player and for a minimum time', async () => {
    const fetchMock = mockApi({ '/api/network': graph });
    const router = renderAt('/netzwerk');
    await chartOption();
    await userEvent.type(screen.getByLabelText('Spieler suchen'), 'bob');
    await waitFor(() => {
      expect(requested(fetchMock, '/api/network').at(-1)?.searchParams.get('focus')).toBe('2');
    });
    expect(screen.getByText('Umfeld von Bob')).toBeInTheDocument();
    // The searched player is ringed.
    const option = await chartOption();
    expect(option.series[0]?.data.find((entry) => entry.id === '2')?.itemStyle?.borderWidth).toBe(
      3,
    );

    await userEvent.selectOptions(screen.getByLabelText('Umfeld'), '2');
    await userEvent.type(screen.getByLabelText('Mindestens gemeinsame Stunden'), '5');
    await waitFor(() => {
      const last = requested(fetchMock, '/api/network').at(-1)?.searchParams;
      expect([last?.get('depth'), last?.get('minS')]).toEqual(['2', String(5 * H)]);
    });
    expect(router.state.location.search).toBe('?spieler=2&umfeld=2&stunden=5');

    await userEvent.click(screen.getByRole('button', { name: 'Ganzes Netz zeigen' }));
    expect(router.state.location.search).toBe('?stunden=5');
  });
});
