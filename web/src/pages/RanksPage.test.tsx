import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RankConfig, RankDraft } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const H = 3600;
const config: RankConfig = {
  ranks: [
    { id: 1, name: 'Neuling', sortOrder: 1, requiredS: H, serverGroupId: 10 },
    { id: 2, name: 'Stammgast', sortOrder: 2, requiredS: 50 * H, serverGroupId: 11 },
  ],
  settings: {
    countMode: 'online',
    excludedGroupIds: [],
    dryRun: true,
    intervalMinutes: 10,
    promotionMessage: { enabled: true, text: 'Glückwunsch zu {rank}!' },
  },
  knownGroups: [
    { id: 6, name: 'Server Admin' },
    { id: 10, name: 'Rang Neuling' },
    { id: 11, name: 'Rang Stammgast' },
    { id: 12, name: 'Rang Veteran' },
  ],
  lastRun: null,
};

function bodies(fetchMock: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchMock.mock.calls
    .filter(
      ([input, init]) =>
        init?.method === method && new URL(input as string, 'http://x').pathname === path,
    )
    .map(([, init]) => JSON.parse(init?.body as string) as RankDraft);
}

function setup(overrides: Record<string, unknown> = {}) {
  return mockApi({
    '/api/ranks': (_url: URL, init?: RequestInit) =>
      init?.method === 'PUT' ? { body: { ...config, lastRun: 5 } } : { body: config },
    '/api/ranks/preview': {
      dryRun: true,
      counts: { up: 1, down: 0, skipped: 2 },
      changes: [
        {
          userId: 7,
          nickname: 'Alice',
          accounts: 2,
          rankingS: 600 * H,
          fromRankId: 2,
          toRankId: 99,
          fromRankName: 'Stammgast',
          toRankName: 'Veteran',
          direction: 'up',
          frozen: false,
        },
      ],
    },
    '/api/ranks/history': {
      items: [
        {
          id: 1,
          at: 1_789_000_000,
          userId: 7,
          nickname: 'Alice',
          fromRankId: 1,
          toRankId: 2,
          fromRankName: 'Neuling',
          toRankName: 'Stammgast',
          rankingS: 60 * H,
          dryRun: true,
          outcome: 'dry_run',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 20,
    },
    '/api/ranks/run': {
      skipped: null,
      full: true,
      dryRun: false,
      checked: 4,
      changed: 1,
      commands: 2,
      pending: 1,
      failed: 0,
    },
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('RanksPage', () => {
  it('shows the ladder, the dry-run state and the history', async () => {
    setup();
    renderAt('/raenge');
    expect(await screen.findByText(/Dry-Run ist an/)).toBeInTheDocument();
    const names = screen.getAllByLabelText('Name');
    expect(names.map((n) => (n as HTMLInputElement).value)).toEqual(['Neuling', 'Stammgast']);
    expect(
      screen.getAllByLabelText('Benötigte Stunden').map((n) => (n as HTMLInputElement).value),
    ).toEqual(['1', '50']);
    expect(await screen.findByText('Neuling → Stammgast')).toBeInTheDocument();
    expect(screen.getByText('Dry-Run')).toBeInTheDocument();
  });

  it('adds a rank, previews the draft and saves it', async () => {
    const fetchMock = setup();
    renderAt('/raenge');
    await screen.findByText(/Dry-Run ist an/);
    await userEvent.click(screen.getByRole('button', { name: 'Rang hinzufügen' }));
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await userEvent.type(screen.getAllByLabelText('Name').at(-1) as HTMLElement, 'Veteran');
    await userEvent.type(
      screen.getAllByLabelText('Benötigte Stunden').at(-1) as HTMLElement,
      '500,5',
    );
    await userEvent.selectOptions(
      screen.getAllByLabelText('Servergruppe').at(-1) as HTMLElement,
      'Rang Veteran',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Server Admin' }));

    await userEvent.click(screen.getByRole('button', { name: 'Vorschau' }));
    const preview = within(
      (await screen.findByRole('heading', { name: 'Vorschau: nächster Lauf' })).closest(
        'section',
      ) as HTMLElement,
    );
    expect(preview.getByText('Aufstiege: 1 · Abstiege: 0 · ausgeschlossen: 2')).toBeInTheDocument();
    expect(preview.getByText('Stammgast → Veteran')).toBeInTheDocument();
    expect(preview.getByText('2 Accounts')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Gespeichert.')).toBeInTheDocument();
    const [saved] = bodies(fetchMock, 'PUT', '/api/ranks');
    expect(saved?.ranks).toEqual([
      { id: 1, name: 'Neuling', requiredS: H, serverGroupId: 10 },
      { id: 2, name: 'Stammgast', requiredS: 50 * H, serverGroupId: 11 },
      { name: 'Veteran', requiredS: 500.5 * H, serverGroupId: 12 },
    ]);
    expect(saved?.settings.excludedGroupIds).toEqual([6]);
    expect(bodies(fetchMock, 'POST', '/api/ranks/preview')[0]).toEqual(saved);
  });

  it('asks before running with dry-run off and shows the result', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    setup({
      '/api/ranks': { ...config, settings: { ...config.settings, dryRun: false } },
    });
    renderAt('/raenge');
    expect(await screen.findByText(/Dry-Run ist aus/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Jetzt ausführen' }));
    expect(confirm).toHaveBeenCalled();
    expect(
      await screen.findByText('Geprüft: 4 · geändert: 1 · Befehle: 2 · vorgemerkt: 1 · Fehler: 0'),
    ).toBeInTheDocument();
  });

  it('blocks invalid rows', async () => {
    setup();
    renderAt('/raenge');
    await screen.findByText(/Dry-Run ist an/);
    const hours = screen.getAllByLabelText('Benötigte Stunden')[0] as HTMLElement;
    await userEvent.clear(hours);
    await userEvent.type(hours, '-3');
    expect(screen.getByText(/Jeder Rang braucht/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Vorschau' })).toBeDisabled();
    });
  });
});
