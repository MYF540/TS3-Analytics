import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PrivateSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const lobby: PrivateSettings['settings']['lobbies'][number] = {
  id: 'main',
  lobbyChannelId: 30,
  parentId: 31,
  nameTemplate: 'Privater Raum von {name}',
  channelGroupId: 5,
  kind: 'temporary',
  deleteDelayS: 300,
  description: '',
  maxClients: -1,
  codecQuality: 6,
  password: false,
  allowedGroupIds: [],
};

const stored: PrivateSettings = {
  settings: {
    enabled: false,
    dryRun: true,
    exemptGroupIds: [],
    lobbies: [lobby],
    cooldownS: 30,
    createdMessage: 'Dein privater Channel wurde angelegt.',
    movedMessage: 'Willkommen zurück.',
    deniedMessage: 'Kein Channel für dich.',
    passwordMessage: 'Passwort: {password}',
  },
  groups: [{ id: 20, name: 'Mitglied' }],
  channels: [
    { id: 30, name: 'Aufzug' },
    { id: 31, name: 'Privaträume' },
    { id: 40, name: 'Zweiter Aufzug' },
  ],
  channelGroups: [{ id: 5, name: 'Channel Admin' }],
  managed: [{ lobbyId: 'main', count: 2 }],
};

function setup(initial: PrivateSettings = stored) {
  const fetchMock = mockApi({
    '/api/automation/private': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...initial, settings: JSON.parse(init.body as string) as unknown }
          : initial,
    }),
  });
  renderAt('/automatik/private');
  const saved = (): PrivateSettings['settings'] | undefined => {
    const call = fetchMock.mock.calls.findLast(([, init]) => init?.method === 'PUT');
    return call ? (JSON.parse(call[1]?.body as string) as PrivateSettings['settings']) : undefined;
  };
  return { saved };
}

const save = () => screen.getByRole('button', { name: 'Speichern' });
const box = (number: number) =>
  within(screen.getByRole('group', { name: `Eingang ${String(number)}` }));

describe('PrivateChannelPage', () => {
  it('shows the stored entrance', async () => {
    setup();
    expect(await screen.findByLabelText('Eingangs-Channel')).toHaveValue('30');
    expect(screen.getByLabelText('Channel-Gruppe für den Besitzer')).toHaveValue('5');
    expect(screen.getByLabelText('Leer bestehen bleiben für (Minuten)')).toHaveValue(5);
    expect(screen.getByText('Private Channels, die es gerade gibt: 2')).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('saves lifetime, password and allowed groups', async () => {
    const { saved } = setup();
    const delay = await screen.findByLabelText('Leer bestehen bleiben für (Minuten)');
    await userEvent.clear(delay);
    await userEvent.type(delay, '60');
    await userEvent.click(screen.getByLabelText(/Mit einem erzeugten Passwort/));
    await userEvent.click(
      within(screen.getByRole('list', { name: 'Erlaubte Servergruppen' })).getByLabelText(
        'Mitglied',
      ),
    );
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toEqual({
      ...stored.settings,
      lobbies: [{ ...lobby, deleteDelayS: 3600, password: true, allowedGroupIds: [20] }],
    });
  });

  it('hides the delete delay for channels that stay', async () => {
    const { saved } = setup();
    await userEvent.selectOptions(await screen.findByLabelText('Lebensdauer'), 'permanent');
    expect(screen.queryByLabelText('Leer bestehen bleiben für (Minuten)')).not.toBeInTheDocument();
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()?.lobbies[0]).toMatchObject({ kind: 'permanent' });
  });

  it('does not save an entrance that is incomplete, doubled or its own parent', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Eingang hinzufügen' }));
    expect(save()).toBeDisabled();
    const second = box(2);
    await userEvent.selectOptions(second.getByLabelText('Eingangs-Channel'), '30');
    await userEvent.selectOptions(second.getByLabelText('Channels anlegen unter'), '31');
    expect(save()).toBeDisabled();
    await userEvent.selectOptions(second.getByLabelText('Eingangs-Channel'), '31');
    expect(save()).toBeDisabled();
    await userEvent.selectOptions(second.getByLabelText('Eingangs-Channel'), '40');
    expect(save()).toBeEnabled();
  });

  it('asks for the channel group as a number while the bot is offline', async () => {
    const { saved } = setup({ ...stored, channelGroups: [] });
    const input = await screen.findByLabelText('Channel-Gruppe für den Besitzer');
    expect(input).toHaveValue(5);
    expect(screen.getByText(/nur als Nummer eintragen/)).toBeInTheDocument();
    await userEvent.clear(input);
    await userEvent.type(input, '9');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()?.lobbies[0]?.channelGroupId).toBe(9);
  });

  it('cannot be switched on without an entrance', async () => {
    setup({ ...stored, settings: { ...stored.settings, lobbies: [] }, managed: [] });
    await userEvent.click(await screen.findByLabelText('Modul einschalten'));
    expect(screen.getByText('Zum Einschalten fehlt mindestens ein Eingang.')).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });
});
