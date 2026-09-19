import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Person } from '../api/types';
import { mockApi, renderAt, requested, sampleUser, sampleUsers } from '../test-utils';

const person: Person = {
  id: 1,
  primaryUserId: 1,
  members: [
    { userId: 1, uid: 'uid-alice=', nickname: 'Alice', addedAt: 1_789_000_000, addedBy: 'mod' },
    { userId: 5, uid: 'uid-alt=', nickname: 'Al1ceAlt', addedAt: 1_789_000_000, addedBy: 'mod' },
  ],
};

function card() {
  const heading = screen.getByRole('heading', { level: 2, name: 'Verknüpfte Accounts' });
  const section = heading.closest('section');
  if (!section) throw new Error('accounts card missing');
  return within(section);
}

function calls(fetchMock: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      (init?.method ?? 'GET') === method && new URL(input as string, 'http://x').pathname === path,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PlayerAccounts', () => {
  it('lists the linked accounts with the primary one', async () => {
    mockApi({ '/api/users/1': { ...sampleUser, person } });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    const accounts = card();
    expect(accounts.getByRole('link', { name: 'Al1ceAlt' })).toHaveAttribute('href', '/spieler/5');
    expect(accounts.getByText('Haupt-Account')).toBeInTheDocument();
    expect(accounts.getByText(/enthalten alle verknüpften Accounts/)).toBeInTheDocument();
    expect(accounts.getByRole('button', { name: 'Zum Haupt-Account machen' })).toBeInTheDocument();
  });

  it('searches and links another account, then reloads the figures', async () => {
    const fetchMock = mockApi({
      '/api/users/1/links': () => ({ body: { person } }),
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(
      card().getByText('Dieser Account ist mit keinem anderen verknüpft.'),
    ).toBeInTheDocument();
    await userEvent.type(card().getByLabelText('Nickname oder UID suchen'), 'bo');
    await userEvent.click(card().getByRole('button', { name: 'Account hinzufügen' }));
    const other = sampleUsers.items.find((u) => u.userId !== 1);
    const result = await card().findByText(other?.nickname ?? 'Unbekannt', { exact: false });
    const row = result.closest('li');
    if (!row) throw new Error('result row missing');
    // The current player (Alice, id 1) is never offered as a result.
    expect(card().getAllByRole('button', { name: 'Verknüpfen' })).toHaveLength(
      sampleUsers.items.length - 1,
    );
    expect(requested(fetchMock, '/api/users').at(-1)?.searchParams.get('search')).toBe('bo');
    await userEvent.click(within(row).getByRole('button', { name: 'Verknüpfen' }));
    await waitFor(() => {
      expect(requested(fetchMock, '/api/users/1')).toHaveLength(2);
    });
    const [link] = calls(fetchMock, 'POST', '/api/users/1/links');
    expect(JSON.parse(link?.[1]?.body as string)).toEqual({ userId: other?.userId });
  });

  it('removes an account after confirmation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = mockApi({
      '/api/users/1': { ...sampleUser, person },
      '/api/users/5/links': () => ({ body: { person: null } }),
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    const [, alt] = card().getAllByRole('button', { name: 'Entfernen' });
    await userEvent.click(alt as HTMLElement);
    await waitFor(() => {
      expect(calls(fetchMock, 'DELETE', '/api/users/5/links')).toHaveLength(1);
    });
  });

  it('is read-only for viewers', async () => {
    mockApi({
      '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } },
      '/api/users/1': { ...sampleUser, person },
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(card().queryByRole('button')).not.toBeInTheDocument();
    expect(card().queryByLabelText('Nickname oder UID suchen')).not.toBeInTheDocument();
  });

  it('marks merged entries in the leaderboard', async () => {
    mockApi({
      '/api/leaderboards': {
        period: 'all',
        metric: 'online',
        fromDay: null,
        toDay: null,
        items: [{ rank: 1, userId: 1, uid: 'a', nickname: 'Alice', value: 3600, accounts: 3 }],
        total: 1,
        page: 1,
        pageSize: 50,
      },
    });
    renderAt('/leaderboards');
    expect(
      await screen.findByLabelText('3 verknüpfte Accounts zusammengerechnet'),
    ).toHaveTextContent('+2');
  });
});
