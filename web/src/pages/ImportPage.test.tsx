import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ImportComparison } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const H = 3600;

const comparison: ImportComparison = {
  items: [
    {
      userId: 1,
      nickname: 'Alice',
      placeholder: false,
      logS: 100 * H,
      legacyS: 2 * H,
      diffS: 98 * H,
    },
    { userId: 2, nickname: null, placeholder: true, logS: 5 * H, legacyS: 0, diffS: 5 * H },
    { userId: 3, nickname: 'Carol', placeholder: false, logS: 0, legacyS: 50 * H, diffS: -50 * H },
  ],
  total: 3,
  matching: 0,
  toleranceS: H,
};

function row(name: string) {
  return within(
    screen.getByRole('rowheader', { name: new RegExp(name) }).closest('tr') as HTMLElement,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ImportPage', () => {
  it('shows both sources and the difference, biggest first', async () => {
    mockApi({ '/api/import/comparison': comparison });
    renderAt('/abgleich');
    await screen.findByText('Alice');
    const cells = row('Alice')
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells.slice(0, 3)).toEqual(['100 h', '2 h', '+98 h']);
    expect(row('Carol').getAllByRole('cell')[2]?.textContent).toBe('−50 h');
    expect(
      screen.getByText(/Spieler mit Daten aus mindestens einer Quelle: 3/),
    ).toBeInTheDocument();
  });

  it('marks a placeholder of the log import', async () => {
    mockApi({ '/api/import/comparison': comparison });
    renderAt('/abgleich');
    expect(await screen.findByText('Platzhalter')).toBeInTheDocument();
  });

  it('asks before a takeover that lowers the ranking time', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = mockApi({ '/api/import/comparison': comparison });
    renderAt('/abgleich');
    await screen.findByText('Carol');
    await userEvent.click(row('Carol').getByRole('button', { name: 'Logzeit übernehmen' }));
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('sinkt die Rangzeit'));
    expect(
      fetchMock.mock.calls.some(([input]) => (input as string).includes('/import/comparison/3')),
    ).toBe(false);
  });

  it('asks the server only for players both sources know, unless told otherwise', async () => {
    const fetchMock = mockApi({ '/api/import/comparison': comparison });
    renderAt('/abgleich');
    await screen.findByText('Alice');
    await userEvent.click(screen.getByLabelText('Nur Spieler, die beide Quellen kennen'));
    await waitFor(() => {
      const urls = fetchMock.mock.calls
        .map(([input]) => new URL(input as string, 'http://x'))
        .filter((url) => url.pathname === '/api/import/comparison')
        .map((url) => url.searchParams.get('both'));
      expect(urls).toEqual(['1', '0']);
    });
  });

  it('sends the decision to take the log time over', async () => {
    const fetchMock = mockApi({
      '/api/import/comparison': comparison,
      '/api/import/comparison/1': { legacyS: 100 * H },
    });
    renderAt('/abgleich');
    await screen.findByText('Alice');
    await userEvent.click(row('Alice').getByRole('button', { name: 'Logzeit übernehmen' }));
    await waitFor(() => {
      const post = fetchMock.mock.calls.find(([input]) =>
        (input as string).includes('/import/comparison/1'),
      );
      expect(JSON.parse(post?.[1]?.body as string)).toEqual({ use: 'logs' });
    });
  });

  it('offers no takeover when both values match', async () => {
    mockApi({
      '/api/import/comparison': {
        ...comparison,
        items: [
          {
            userId: 4,
            nickname: 'Dora',
            placeholder: false,
            logS: 10 * H,
            legacyS: 10 * H,
            diffS: 0,
          },
        ],
        total: 1,
        matching: 1,
      },
    });
    renderAt('/abgleich');
    await screen.findByText('Dora');
    expect(row('Dora').getByRole('button', { name: 'Logzeit übernehmen' })).toBeDisabled();
  });

  it('stays hidden from moderators', async () => {
    mockApi({ '/api/auth/me': { user: { id: 3, username: 'mod', role: 'moderator' } } });
    renderAt('/abgleich');
    expect(await screen.findByText('Keine Berechtigung')).toBeInTheDocument();
  });
});
