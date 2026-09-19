import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ActivitySettingsResponse } from '../api/types';
import { de } from '../i18n/de';
import { mockApi, renderAt } from '../test-utils';

const FORBIDDEN = de['page.forbidden.title'];

const response: ActivitySettingsResponse = {
  settings: {
    idleThresholdS: 600,
    afkChannelIds: [9, 42],
    awayIsAfk: true,
    outputMutedIsAfk: true,
  },
  defaults: { idleThresholdS: 600, afkChannelIds: [], awayIsAfk: true, outputMutedIsAfk: true },
  channels: [
    { id: 9, name: 'AFK', lastSeen: 1_789_800_000 },
    { id: 3, name: 'Gaming', lastSeen: 1_789_800_000 },
    { id: 5, name: 'Alter Raum', lastSeen: 1_700_000_000 },
  ],
};

function putBodies(fetchMock: ReturnType<typeof mockApi>): unknown[] {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);
}

function setup() {
  return mockApi({
    '/api/settings/activity': (_url: URL, init?: RequestInit) =>
      init?.method === 'PUT'
        ? { body: JSON.parse(init.body as string) as unknown }
        : { body: response },
  });
}

describe('SettingsPage', () => {
  it('shows the current rules with selected AFK channels', async () => {
    setup();
    renderAt('/einstellungen');
    expect(await screen.findByLabelText('Inaktiv nach (Minuten)')).toHaveValue(10);
    expect(screen.getByRole('checkbox', { name: 'Status „Abwesend“ zählt als AFK' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^AFK/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /^Gaming/ })).not.toBeChecked();
    // Selected but no longer known channel stays visible and can be removed.
    expect(screen.getByRole('checkbox', { name: 'Unbekannter Channel #42' })).toBeChecked();
    expect(screen.getByText(/zuletzt gesehen/)).toBeInTheDocument();
    expect(
      screen.getByText(/Bereits erfasste Zeiten werden nicht neu bewertet/),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  it('saves changed rules in seconds', async () => {
    const fetchMock = setup();
    renderAt('/einstellungen');
    const idle = await screen.findByLabelText('Inaktiv nach (Minuten)');
    await userEvent.clear(idle);
    await userEvent.type(idle, '15');
    await userEvent.click(screen.getByRole('checkbox', { name: /^Gaming/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Unbekannter Channel #42' }));
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Lautsprecher stumm zählt als AFK' }),
    );
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    expect(await screen.findByText('Gespeichert.')).toHaveAttribute('role', 'status');
    const [body] = putBodies(fetchMock) as { afkChannelIds: number[] }[];
    expect({ ...body, afkChannelIds: [...(body?.afkChannelIds ?? [])].sort() }).toEqual({
      idleThresholdS: 900,
      afkChannelIds: [3, 9],
      awayIsAfk: true,
      outputMutedIsAfk: false,
    });
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  it('blocks invalid idle values and can reset to defaults', async () => {
    setup();
    renderAt('/einstellungen');
    const idle = await screen.findByLabelText('Inaktiv nach (Minuten)');
    await userEvent.clear(idle);
    await userEvent.type(idle, '0');
    expect(
      screen.getByText('Bitte eine ganze Zahl zwischen 1 und 1440 eingeben.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Standardwerte eintragen' }));
    expect(idle).toHaveValue(10);
    expect(screen.getByRole('checkbox', { name: /^AFK/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Änderungen verwerfen' }));
    expect(screen.getByRole('checkbox', { name: /^AFK/ })).toBeChecked();
  });

  it('filters the channel list but keeps selected channels', async () => {
    setup();
    renderAt('/einstellungen');
    await userEvent.type(await screen.findByLabelText('Channels filtern'), 'gam');
    const list = screen.getByRole('list');
    expect(within(list).getByText('Gaming')).toBeInTheDocument();
    expect(within(list).getByText('AFK')).toBeInTheDocument();
    expect(within(list).queryByText('Alter Raum')).not.toBeInTheDocument();
  });

  it('is reachable from the navigation for admins only', async () => {
    setup();
    renderAt('/');
    expect(await screen.findByRole('link', { name: 'Einstellungen' })).toBeInTheDocument();
  });

  it('shows the forbidden page for viewers', async () => {
    mockApi({ '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } } });
    renderAt('/einstellungen');
    expect(await screen.findByRole('heading', { level: 1, name: FORBIDDEN })).toBeInTheDocument();
    expect(screen.queryByLabelText('Inaktiv nach (Minuten)')).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Einstellungen' })).not.toBeInTheDocument();
  });
});
