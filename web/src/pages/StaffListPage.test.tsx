import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { StaffSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const stored: StaffSettings = {
  settings: {
    enabled: false,
    dryRun: true,
    exemptGroupIds: [],
    channelId: 20,
    groups: [
      { groupId: 6, title: '' },
      { groupId: 7, title: 'Moderation' },
    ],
    showInAll: false,
    awayInAfkChannel: true,
    header: '',
    footer: '',
    groupLine: '[b]{group}[/b]',
    memberLine: '{name} – {status}',
    online: 'online',
    away: 'abwesend',
    offline: 'offline',
    empty: 'niemand',
    hideEmptyGroups: false,
    clickable: true,
  },
  groups: [
    { id: 6, name: 'Server Admin' },
    { id: 7, name: 'Moderator' },
    { id: 9, name: 'Supporter' },
  ],
  channels: [{ id: 20, name: 'Team' }],
};

function setup(settings: Partial<StaffSettings['settings']> = {}) {
  const initial = { ...stored, settings: { ...stored.settings, ...settings } };
  const fetchMock = mockApi({
    '/api/automation/staff': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...stored, settings: JSON.parse(init.body as string) as unknown }
          : initial,
    }),
  });
  renderAt('/automatik/staff');
  const saved = (): StaffSettings['settings'] | undefined => {
    const call = fetchMock.mock.calls.findLast(([, init]) => init?.method === 'PUT');
    return call ? (JSON.parse(call[1]?.body as string) as StaffSettings['settings']) : undefined;
  };
  return { saved };
}

const save = () => screen.getByRole('button', { name: 'Speichern' });
const listed = () =>
  within(screen.getByRole('list', { name: 'Gruppen der Liste' }))
    .getAllByRole('listitem')
    .map((item) => item.querySelector('strong')?.textContent);

describe('StaffListPage', () => {
  it('shows the groups in their order, without the exempt groups of other modules', async () => {
    setup();
    await screen.findByLabelText('Channel für die Liste');
    expect(listed()).toEqual(['Server Admin', 'Moderator']);
    expect(screen.getByLabelText('Überschrift für Moderator (optional)')).toHaveValue('Moderation');
    expect(screen.queryByText('Servergruppen ausnehmen')).not.toBeInTheDocument();
  });

  it('reorders, adds and removes groups', async () => {
    const { saved } = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Moderator nach oben' }));
    expect(listed()).toEqual(['Moderator', 'Server Admin']);
    await userEvent.selectOptions(screen.getByLabelText('Gruppe hinzufügen'), '9');
    await userEvent.click(screen.getByRole('button', { name: 'Hinzufügen' }));
    await userEvent.click(screen.getByRole('button', { name: 'Server Admin entfernen' }));
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()?.groups).toEqual([
      { groupId: 7, title: 'Moderation' },
      { groupId: 9, title: '' },
    ]);
  });

  it('saves texts and options', async () => {
    const { saved } = setup();
    await userEvent.type(await screen.findByLabelText('Text über der Liste'), 'Unser Team');
    await userEvent.click(screen.getByLabelText('Namen anklickbar machen'));
    await userEvent.clear(screen.getByLabelText('Status „online“'));
    await userEvent.type(screen.getByLabelText('Status „online“'), 'da');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toMatchObject({ header: 'Unser Team', clickable: false, online: 'da' });
  });

  it('cannot be switched on without a group', async () => {
    setup({ groups: [] });
    await userEvent.click(await screen.findByLabelText('Modul einschalten'));
    expect(screen.getByText(/Zum Einschalten fehlen der Channel/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });
});
