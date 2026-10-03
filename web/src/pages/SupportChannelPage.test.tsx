import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SupportSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const stored: SupportSettings = {
  settings: {
    enabled: false,
    dryRun: true,
    exemptGroupIds: [],
    channelId: null,
    supporterGroupIds: [],
    notify: 'poke',
    supporterMessage: '{name} wartet im Support.',
    userMessage: 'Hallo {name}, das Team wurde informiert.',
    nobodyMessage: 'Hallo {name}, es ist niemand da.',
    cooldownS: 60,
    autoOpen: {
      enabled: false,
      openName: 'Support [offen]',
      closedName: 'Support [geschlossen]',
      openMaxClients: -1,
      closedMaxClients: 0,
    },
  },
  groups: [
    { id: 6, name: 'Server Admin' },
    { id: 8, name: 'Guest' },
  ],
  channels: [
    { id: 20, name: 'Support' },
    { id: 1, name: 'Lobby' },
  ],
};

function setup() {
  const fetchMock = mockApi({
    '/api/automation/support': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...stored, settings: JSON.parse(init.body as string) as unknown }
          : stored,
    }),
  });
  renderAt('/automatik/support');
  const saved = (): unknown => {
    const call = fetchMock.mock.calls.findLast(([, init]) => init?.method === 'PUT');
    return call ? JSON.parse(call[1]?.body as string) : undefined;
  };
  return { saved };
}

const team = () => within(screen.getByRole('list', { name: 'Team-Gruppen' }));
const save = () => screen.getByRole('button', { name: 'Speichern' });

describe('SupportChannelPage', () => {
  it('saves channel, team and texts', async () => {
    const { saved } = setup();
    await userEvent.selectOptions(await screen.findByLabelText('Support-Channel'), '20');
    await userEvent.click(team().getByLabelText('Server Admin'));
    await userEvent.click(screen.getByLabelText('Modul einschalten'));
    await userEvent.selectOptions(screen.getByLabelText('Team benachrichtigen per'), 'message');
    await userEvent.clear(screen.getByLabelText('Wartezeit je Spieler (Sekunden)'));
    await userEvent.type(screen.getByLabelText('Wartezeit je Spieler (Sekunden)'), '120');
    await userEvent.click(save());

    await screen.findByText('Gespeichert.');
    expect(saved()).toEqual({
      ...stored.settings,
      enabled: true,
      channelId: 20,
      supporterGroupIds: [6],
      notify: 'message',
      cooldownS: 120,
    });
  });

  it('does not let the module be switched on without channel and team', async () => {
    setup();
    await userEvent.click(await screen.findByLabelText('Modul einschalten'));
    expect(screen.getByText(/Zum Einschalten fehlen/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Support-Channel'), '20');
    await userEvent.click(team().getByLabelText('Guest'));
    expect(screen.queryByText(/Zum Einschalten fehlen/)).not.toBeInTheDocument();
    expect(save()).toBeEnabled();
  });

  it('saves the automatic opening with names and limits', async () => {
    const { saved } = setup();
    await userEvent.click(await screen.findByLabelText(/Channel umbenennen und sperren/));
    await userEvent.clear(screen.getByLabelText('Name, wenn geschlossen'));
    // user-event reads "[" as the start of a key name; "[[" types the character itself.
    await userEvent.type(screen.getByLabelText('Name, wenn geschlossen'), 'Support [[zu]');
    await userEvent.clear(screen.getByLabelText('Client-Limit, wenn geöffnet'));
    await userEvent.type(screen.getByLabelText('Client-Limit, wenn geöffnet'), '10');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toMatchObject({
      autoOpen: {
        enabled: true,
        openName: 'Support [offen]',
        closedName: 'Support [zu]',
        openMaxClients: 10,
        closedMaxClients: 0,
      },
    });
  });

  it('refuses identical names and empty texts', async () => {
    setup();
    await userEvent.clear(await screen.findByLabelText('Name, wenn geschlossen'));
    await userEvent.type(screen.getByLabelText('Name, wenn geschlossen'), 'Support [[offen]');
    expect(save()).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Name, wenn geschlossen'), '!');
    expect(save()).toBeEnabled();
    await userEvent.clear(screen.getByLabelText('Text an das Team'));
    expect(save()).toBeDisabled();
  });
});
