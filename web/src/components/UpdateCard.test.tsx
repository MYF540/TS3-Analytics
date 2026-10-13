import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateInfo } from '../api/types';
import { mockApi } from '../test-utils';
import { UpdateCard } from './UpdateCard';

const current: UpdateInfo = {
  enabled: true,
  currentVersion: '1.1.0',
  latest: null,
  updateAvailable: false,
  installBlocker: null,
  lastRun: null,
};

const newer: UpdateInfo = {
  ...current,
  latest: {
    version: '1.2.0',
    url: 'https://github.com/example/app/releases/tag/v1.2.0',
    publishedAt: 1_789_700_000,
    notes: 'Neu: alles besser.',
    checkedAt: 1_789_800_000,
  },
  updateAvailable: true,
};

type Mock = ReturnType<typeof mockApi>;
const posts = (fetchMock: Mock) =>
  fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'POST')
    .map(([input]) => input as string);

afterEach(() => {
  vi.restoreAllMocks();
});

describe('UpdateCard', () => {
  it('shows the installed version before anything was checked', async () => {
    mockApi({ '/api/update': current });
    render(<UpdateCard />);
    expect(await screen.findByText('Installiert: Version 1.1.0')).toBeInTheDocument();
    expect(screen.getByText('Es wurde noch nicht nach Updates gesucht.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /installieren/ })).not.toBeInTheDocument();
  });

  it('looks for updates on request and offers the release it found', async () => {
    const fetchMock = mockApi({ '/api/update': current, '/api/update/check': newer });
    render(<UpdateCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Nach Updates suchen' }));
    expect(await screen.findByText('Version 1.2.0 verfügbar')).toBeInTheDocument();
    expect(screen.getByText('Neu: alles besser.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Release auf GitHub ansehen' })).toHaveAttribute(
      'href',
      newer.latest?.url,
    );
    expect(posts(fetchMock)).toEqual(['/api/update/check']);
  });

  it('says so when the installed version is the latest', async () => {
    mockApi({
      '/api/update': { ...newer, updateAvailable: false, currentVersion: '1.2.0' },
    });
    render(<UpdateCard />);
    expect(await screen.findByText('aktuell')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /installieren/ })).not.toBeInTheDocument();
  });

  it('starts the update only after the question was confirmed', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = mockApi({ '/api/update': newer, '/api/update/install': newer });
    render(<UpdateCard />);
    const button = await screen.findByRole('button', { name: 'Update auf 1.2.0 installieren' });
    await userEvent.click(button);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('Version 1.2.0'));
    expect(posts(fetchMock)).toEqual([]);

    confirm.mockReturnValue(true);
    await userEvent.click(button);
    expect(await screen.findByText(/Update auf 1.2.0 läuft/)).toBeInTheDocument();
    expect(posts(fetchMock)).toEqual(['/api/update/install']);
    expect(button).toBeDisabled();
  });

  it('offers no button when the installation cannot update itself', async () => {
    mockApi({ '/api/update': { ...newer, installBlocker: 'no_git' } });
    render(<UpdateCard />);
    expect(await screen.findByText(/kein Git-Verzeichnis/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /installieren/ })).not.toBeInTheDocument();
  });

  it('reports a failed update with what the script said', async () => {
    mockApi({
      '/api/update': {
        ...newer,
        lastRun: {
          state: 'failed',
          version: 'v1.2.0',
          at: 1_789_800_500,
          message: 'Build schlug fehl – vorheriger Stand wiederhergestellt',
        },
      },
    });
    render(<UpdateCard />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Das Update auf v1.2.0 .* ist fehlgeschlagen: Build schlug fehl – vorheriger Stand/,
    );
  });

  it('shows what the server says when the check fails', async () => {
    mockApi({
      '/api/update': current,
      '/api/update/check': () => ({
        status: 502,
        body: { error: { code: 'UPDATE_CHECK_FAILED', message: 'x' } },
      }),
    });
    render(<UpdateCard />);
    await userEvent.click(await screen.findByRole('button', { name: 'Nach Updates suchen' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/GitHub war nicht erreichbar/);
    });
  });

  it('stays out of the way when the updater is switched off', async () => {
    const fetchMock = mockApi();
    const { container } = render(<UpdateCard />);
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    expect(container).toBeEmptyDOMElement();
  });
});
