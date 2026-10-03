import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ChannelsSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const area: ChannelsSettings['settings']['areas'][number] = {
  id: 'talk',
  parentId: 50,
  naming: 'numbered',
  prefix: 'Talk',
  names: [],
  minFree: 1,
  maxChannels: 20,
  maxClients: -1,
  codecQuality: 6,
  joinPower: 0,
  talkPower: 0,
  description: '',
};

const stored: ChannelsSettings = {
  settings: { enabled: false, dryRun: true, exemptGroupIds: [], areas: [area] },
  channels: [
    { id: 50, name: 'Gespräche' },
    { id: 70, name: 'Farben' },
  ],
  managed: [{ areaId: 'talk', count: 3 }],
};

function setup(initial: ChannelsSettings = stored) {
  const fetchMock = mockApi({
    '/api/automation/channels': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...initial, settings: JSON.parse(init.body as string) as unknown }
          : initial,
    }),
    '/api/automation/channels/adopt': { adopted: 2 },
  });
  renderAt('/automatik/channels');
  const sent = (method: string): unknown => {
    const call = fetchMock.mock.calls.findLast(([, init]) => init?.method === method);
    return call ? JSON.parse(call[1]?.body as string) : undefined;
  };
  return { sent };
}

const save = () => screen.getByRole('button', { name: 'Speichern' });
const areaBox = (number: number) =>
  within(screen.getByRole('group', { name: `Bereich ${String(number)}` }));

describe('ChannelCreatorPage', () => {
  it('shows the stored area and how many channels the bot manages there', async () => {
    setup();
    expect(await screen.findByLabelText('Bezeichnung')).toHaveValue('Talk');
    expect(screen.getByLabelText('Übergeordneter Channel')).toHaveValue('50');
    expect(
      screen.getByText('Vom Bot verwaltete Channels in diesem Bereich: 3'),
    ).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('saves a changed area', async () => {
    const { sent } = setup();
    const limit = await screen.findByLabelText('Client-Limit je Channel');
    await userEvent.clear(limit);
    await userEvent.type(limit, '5');
    await userEvent.type(screen.getByLabelText('Beschreibung der Channels'), 'Hallo');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(sent('PUT')).toEqual({
      ...stored.settings,
      areas: [{ ...area, maxClients: 5, description: 'Hallo' }],
    });
  });

  it('adds an area with names from a list', async () => {
    const { sent } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Bereich hinzufügen' }));
    expect(save()).toBeDisabled();
    const box = areaBox(2);
    await userEvent.selectOptions(box.getByLabelText('Übergeordneter Channel'), '70');
    await userEvent.selectOptions(box.getByLabelText('Namen der Channels'), 'list');
    await userEvent.type(box.getByLabelText('Namen, einer je Zeile'), 'Rot\nBlau\n');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    const areas = (sent('PUT') as ChannelsSettings['settings']).areas;
    expect(areas).toHaveLength(2);
    expect(areas[1]).toMatchObject({ parentId: 70, naming: 'list', names: ['Rot', 'Blau'] });
    expect(areas[1]?.id).toMatch(/^a[a-z0-9]+$/);
  });

  it('does not save two areas below the same channel or a number out of range', async () => {
    setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Bereich hinzufügen' }));
    const box = areaBox(2);
    await userEvent.selectOptions(box.getByLabelText('Übergeordneter Channel'), '50');
    await userEvent.type(box.getByLabelText('Bezeichnung'), 'Runde');
    expect(screen.getByText(/nur zu einem Bereich gehören/)).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await userEvent.selectOptions(box.getByLabelText('Übergeordneter Channel'), '70');
    expect(save()).toBeEnabled();
    await userEvent.clear(box.getByLabelText('Leere Channels, die immer da sind'));
    await userEvent.type(box.getByLabelText('Leere Channels, die immer da sind'), '9');
    expect(save()).toBeDisabled();
  });

  it('hands existing channels over to the bot', async () => {
    const { sent } = setup();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Vorhandene Channels übernehmen' }),
    );
    expect(await screen.findByText('Übernommene Channels: 2')).toBeInTheDocument();
    expect(sent('POST')).toEqual({ areaId: 'talk' });
  });

  it('offers the takeover only for saved, unchanged settings', async () => {
    setup();
    await userEvent.type(await screen.findByLabelText('Bezeichnung'), 'x');
    expect(screen.getByRole('button', { name: 'Vorhandene Channels übernehmen' })).toBeDisabled();
  });

  it('removes an area', async () => {
    const { sent } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Bereich entfernen' }));
    expect(screen.getByText('Noch kein Bereich eingerichtet.')).toBeInTheDocument();
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(sent('PUT')).toMatchObject({ areas: [] });
  });
});
