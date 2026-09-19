import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, requested } from '../test-utils';

const lastQuery = (fetchMock: ReturnType<typeof mockApi>) =>
  requested(fetchMock, '/api/users').at(-1)?.searchParams;

describe('PlayersPage', () => {
  it('lists players with play time, online status and a link to the detail page', async () => {
    mockApi();
    renderAt('/spieler');
    const alice = await screen.findByRole('link', { name: 'Alice' });
    expect(alice).toHaveAttribute('href', '/spieler/1');
    const row = alice.closest('tr');
    if (!row) throw new Error('row missing');
    expect(within(row).getByText('online')).toBeInTheDocument();
    expect(within(row).getByText('25 h')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Unbekannt' })).toBeInTheDocument();
    expect(screen.getByText('120 Spieler')).toBeInTheDocument();
  });

  it('searches after a short pause and keeps the query in the URL', async () => {
    const fetchMock = mockApi();
    const router = renderAt('/spieler');
    await screen.findByRole('link', { name: 'Alice' });
    await userEvent.type(screen.getByRole('searchbox'), 'ali');
    await waitFor(() => {
      expect(lastQuery(fetchMock)?.get('search')).toBe('ali');
    });
    expect(router.state.location.search).toBe('?q=ali');
    // One request for the final term, not one per keystroke.
    expect(
      requested(fetchMock, '/api/users').filter((u) => u.searchParams.get('search')),
    ).toHaveLength(1);
  });

  it('sorts by clicking column headers', async () => {
    const fetchMock = mockApi();
    renderAt('/spieler');
    await screen.findByRole('link', { name: 'Alice' });
    await userEvent.click(screen.getByRole('button', { name: /Nickname/ }));
    await waitFor(() => {
      expect(lastQuery(fetchMock)?.get('sort')).toBe('nickname');
    });
    expect(lastQuery(fetchMock)?.get('order')).toBe('asc');
    expect(screen.getByRole('columnheader', { name: /Nickname/ })).toHaveAttribute(
      'aria-sort',
      'ascending',
    );
    await userEvent.click(screen.getByRole('button', { name: /Nickname/ }));
    await waitFor(() => {
      expect(lastQuery(fetchMock)?.get('order')).toBe('desc');
    });
  });

  it('shows casual players on request and paginates', async () => {
    const fetchMock = mockApi();
    renderAt('/spieler');
    await screen.findByRole('link', { name: 'Alice' });
    await userEvent.click(screen.getByRole('checkbox'));
    await waitFor(() => {
      expect(lastQuery(fetchMock)?.get('includeCasual')).toBe('true');
    });
    expect(screen.getByText('Seite 1 von 3')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Weiter' }));
    await waitFor(() => {
      expect(lastQuery(fetchMock)?.get('page')).toBe('2');
    });
    expect(lastQuery(fetchMock)?.get('includeCasual')).toBe('true');
  });

  it('offers a CSV export of the current selection', async () => {
    mockApi();
    renderAt('/spieler?q=bob&sort=lastSeen&order=asc&casual=1');
    const link = await screen.findByRole('link', { name: 'Als CSV exportieren' });
    expect(link).toHaveAttribute(
      'href',
      '/api/users/export.csv?search=bob&sort=lastSeen&order=asc&includeCasual=true',
    );
  });

  it('restores its state from the URL', async () => {
    const fetchMock = mockApi();
    renderAt('/spieler?q=bob&sort=lastSeen&order=asc&page=2');
    await screen.findByRole('link', { name: 'Alice' });
    expect(screen.getByRole('searchbox')).toHaveValue('bob');
    expect(Object.fromEntries(lastQuery(fetchMock) ?? [])).toMatchObject({
      search: 'bob',
      sort: 'lastSeen',
      order: 'asc',
      page: '2',
    });
  });
});
