import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AutomationLogEntry, AutomationOverview, Paged } from '../api/types';
import { mockApi, renderAt, requested } from '../test-utils';

const overview: AutomationOverview = {
  modules: [
    { id: 'nickname', enabled: true, dryRun: true },
    { id: 'support', enabled: true, dryRun: false },
    { id: 'spam', enabled: false, dryRun: true },
  ],
  retentionDays: 90,
};

const log: Paged<AutomationLogEntry> = {
  items: [
    {
      id: 2,
      at: 1_789_800_000,
      module: 'nickname',
      action: 'kick',
      userId: 7,
      nickname: 'Alice',
      detail: 'Muster „admin“',
      result: 'dry',
    },
    {
      id: 1,
      at: 1_789_799_000,
      module: 'channels',
      action: 'channel.create',
      userId: null,
      nickname: null,
      detail: 'Talk 3',
      result: 'failed',
    },
  ],
  total: 2,
  page: 1,
  pageSize: 50,
};

const viewer = { user: { id: 2, username: 'vera', role: 'viewer' } };

function rowOf(text: string) {
  const row = screen.getByText(text).closest('tr');
  if (!row) throw new Error('row missing');
  return within(row);
}

describe('AutomationPage', () => {
  it('shows for every module whether it is off, testing or live', async () => {
    mockApi({ '/api/automation': overview, '/api/automation/log': log });
    renderAt('/automatik');
    await screen.findByRole('rowheader', { name: 'Nickname-Checker' });
    expect(
      rowOf('Prüft Nicknames gegen eine Liste verbotener Muster.').getByText('Testmodus'),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('rowheader', { name: 'Support-Channel' }).closest('tr') as HTMLElement,
      ).getByText('aktiv'),
    ).toBeInTheDocument();
    expect(
      within(
        screen.getByRole('rowheader', { name: 'Spam-Control' }).closest('tr') as HTMLElement,
      ).getByText('aus'),
    ).toBeInTheDocument();
  });

  it('lists what the modules did, with player link and result', async () => {
    mockApi({ '/api/automation': overview, '/api/automation/log': log });
    renderAt('/automatik');
    const link = await screen.findByRole('link', { name: 'Alice' });
    expect(link).toHaveAttribute('href', '/spieler/7');
    const row = rowOf('Muster „admin“');
    expect(row.getByText('Kick vom Server')).toBeInTheDocument();
    expect(row.getByText('nur Test')).toBeInTheDocument();
    // An action without a German name is shown as it is.
    expect(rowOf('Talk 3').getByText('channel.create')).toBeInTheDocument();
    expect(rowOf('Talk 3').getByText('fehlgeschlagen')).toBeInTheDocument();
    expect(screen.getByText('Einträge werden nach 90 Tagen gelöscht.')).toBeInTheDocument();
  });

  it('asks the server for one module when the filter is used', async () => {
    const fetchMock = mockApi({ '/api/automation': overview, '/api/automation/log': log });
    renderAt('/automatik');
    await screen.findByRole('link', { name: 'Alice' });
    await userEvent.selectOptions(screen.getByLabelText('Modul'), 'spam');
    await waitFor(() => {
      expect(requested(fetchMock, '/api/automation/log').at(-1)?.searchParams.get('module')).toBe(
        'spam',
      );
    });
  });

  it('says so when there are no modules and no entries yet', async () => {
    mockApi({
      '/api/automation': { modules: [], retentionDays: 90 },
      '/api/automation/log': { items: [], total: 0, page: 1, pageSize: 50 },
    });
    renderAt('/automatik');
    expect(
      await screen.findByText('In dieser Version sind noch keine Module verfügbar.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Noch keine Einträge für diese Auswahl.')).toBeInTheDocument();
  });

  it('is not reachable for viewers', async () => {
    mockApi({ '/api/auth/me': viewer });
    renderAt('/automatik');
    await waitFor(() => {
      expect(screen.queryByRole('heading', { name: 'Automatik' })).not.toBeInTheDocument();
    });
  });
});
