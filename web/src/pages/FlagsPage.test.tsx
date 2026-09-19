import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { FlagItem, FlagsResponse } from '../api/types';
import { mockApi, renderAt, requested } from '../test-utils';

const NOW = 1_789_800_000;

const base: Omit<FlagItem, 'id' | 'kind' | 'level' | 'user' | 'related' | 'ban'> = {
  status: 'open',
  evidence: { sharedIps: 2, sharedSubnets: 1, lastSeen: NOW - 600 },
  firstDetected: NOW - 86_400,
  lastDetected: NOW,
  current: true,
  decidedBy: null,
  decidedAt: null,
};

const flags: FlagItem[] = [
  {
    ...base,
    id: 1,
    kind: 'ban_ip',
    level: 'high',
    user: { id: 1, nickname: 'Alice' },
    related: { id: 9, nickname: 'Troll' },
    ban: { id: 4, reason: 'Beleidigung', active: true },
  },
  {
    ...base,
    id: 2,
    kind: 'ban_subnet',
    level: 'medium',
    user: { id: 3, nickname: null },
    related: null,
    ban: { id: 5, reason: null, active: false },
    current: false,
  },
  {
    ...base,
    id: 3,
    kind: 'shared_ip',
    level: 'info',
    user: { id: 1, nickname: 'Alice' },
    related: { id: 2, nickname: 'Bob' },
    ban: null,
    evidence: { sharedIps: 1, sharedSubnets: 0, lastSeen: NOW - 60 },
  },
];

const response: FlagsResponse = {
  items: flags,
  total: 3,
  page: 1,
  pageSize: 25,
  openCounts: { high: 1, medium: 1, info: 1 },
  lastRun: NOW,
};

function setup(overrides: Record<string, unknown> = {}) {
  return mockApi({
    '/api/flags': response,
    '/api/flags/1/status': (_url: URL, init?: RequestInit) => ({
      body: { id: 1, status: (JSON.parse(init?.body as string) as { status: string }).status },
    }),
    ...overrides,
  });
}

describe('FlagsPage', () => {
  it('explains each flag with links to the players', async () => {
    setup();
    renderAt('/hinweise');
    const items = await screen.findAllByRole('listitem');
    expect(items).toHaveLength(3);
    const [high, medium, info] = items.map((item) => within(item));
    expect(high?.getByText('Hoch')).toBeInTheDocument();
    expect(high?.getByRole('link', { name: 'Alice' })).toHaveAttribute('href', '/spieler/1');
    expect(high?.getByRole('link', { name: 'Troll' })).toHaveAttribute('href', '/spieler/9');
    expect(high?.getByText(/gebannte Spieler/)).toBeInTheDocument();
    expect(high?.getByText('Ban-Grund: Beleidigung')).toBeInTheDocument();
    expect(
      high?.getByText(/Gemeinsame IP-Adressen: 2 · gemeinsame Subnetze: 1/),
    ).toBeInTheDocument();

    expect(medium?.getByText(/im Subnetz eines IP-Bans \(#5\)/)).toBeInTheDocument();
    expect(medium?.getByRole('link', { name: 'Spieler #3' })).toBeInTheDocument();
    expect(medium?.getByText('Trifft nicht mehr zu (z. B. Ban aufgehoben)')).toBeInTheDocument();
    expect(medium?.getByText(/Ban aufgehoben$/)).toBeInTheDocument();
    // Without a second account there is nothing to link.
    expect(medium?.queryByRole('button', { name: 'Verknüpfen' })).not.toBeInTheDocument();

    expect(info?.getByText(/haben dieselbe IP-Adresse genutzt/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Hoch/ })).toHaveTextContent('1');
  });

  it('filters by status, level and player through the URL', async () => {
    const fetchMock = setup();
    renderAt('/hinweise?spieler=1');
    await screen.findAllByRole('listitem');
    expect(requested(fetchMock, '/api/flags').at(-1)?.searchParams.get('userId')).toBe('1');
    expect(screen.getByText('Nur Hinweise zu Alice')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('tab', { name: 'Ignoriert' }));
    await userEvent.click(screen.getByRole('radio', { name: /Mittel/ }));
    await waitFor(() => {
      const last = requested(fetchMock, '/api/flags').at(-1);
      expect(last?.searchParams.get('status')).toBe('ignored');
      expect(last?.searchParams.get('level')).toBe('medium');
    });
    await userEvent.click(screen.getByRole('button', { name: 'Filter aufheben' }));
    await waitFor(() => {
      expect(requested(fetchMock, '/api/flags').at(-1)?.searchParams.get('userId')).toBeNull();
    });
  });

  it('ignores a flag and reloads the list', async () => {
    const fetchMock = setup();
    renderAt('/hinweise');
    const [first] = await screen.findAllByRole('listitem');
    await userEvent.click(within(first as HTMLElement).getByRole('button', { name: 'Ignorieren' }));
    await waitFor(() => {
      expect(requested(fetchMock, '/api/flags')).toHaveLength(2);
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ status: 'ignored' });
  });

  it('shows the decision and offers reopening', async () => {
    setup({
      '/api/flags': {
        ...response,
        items: [{ ...flags[0], status: 'ignored', decidedBy: 'mod', decidedAt: NOW - 60 }],
        total: 1,
      },
    });
    renderAt('/hinweise?status=ignored');
    const [item] = await screen.findAllByRole('listitem');
    const card = within(item as HTMLElement);
    expect(card.getByText(/Ignoriert von mod am/)).toBeInTheDocument();
    expect(card.getByRole('button', { name: 'Wieder öffnen' })).toBeInTheDocument();
  });

  it('is hidden from viewers', async () => {
    setup({ '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } } });
    renderAt('/hinweise');
    expect(await screen.findByRole('heading', { name: 'Keine Berechtigung' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Hinweise' })).not.toBeInTheDocument();
  });

  it('is linked from the player page when there are open flags', async () => {
    setup({ '/api/flags': { ...response, total: 2 } });
    renderAt('/spieler/1');
    const link = await screen.findByRole('link', { name: 'Anzeigen' });
    expect(link).toHaveAttribute('href', '/hinweise?spieler=1');
    expect(screen.getByText(/2 offene Hinweise zu diesem Spieler/)).toBeInTheDocument();
  });
});
