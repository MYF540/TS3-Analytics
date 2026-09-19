import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ModerationSettings } from '../api/types';
import { mockApi, renderAt, sampleUser } from '../test-utils';

const settings: ModerationSettings = {
  enabled: true,
  banTemplates: [
    { id: 'spam', label: 'Spam', reason: 'Spam', durationS: 3600 },
    { id: 'cheating', label: 'Cheating', reason: 'Cheating', durationS: 0 },
  ],
};

function card() {
  const heading = screen.getByRole('heading', { level: 2, name: 'Moderation' });
  const section = heading.closest('section');
  if (!section) throw new Error('moderation card missing');
  return within(section);
}

function posted(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls
    .filter(([input, init]) => init?.method === 'POST' && (input as string).includes('/moderation'))
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);
}

function setup(overrides: Record<string, unknown> = {}) {
  return mockApi({
    '/api/settings/moderation': settings,
    '/api/users/1/moderation': () => ({ body: { affected: 1 } }),
    '/api/settings/activity': {
      settings: { idleThresholdS: 600, afkChannelIds: [], awayIsAfk: true, outputMutedIsAfk: true },
      defaults: { idleThresholdS: 600, afkChannelIds: [], awayIsAfk: true, outputMutedIsAfk: true },
      channels: [
        { id: 3, name: 'Gaming', lastSeen: 1 },
        { id: 9, name: 'AFK', lastSeen: 1 },
      ],
    },
    ...overrides,
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ModerationCard', () => {
  it('pokes an online player', async () => {
    const fetchMock = setup();
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    await userEvent.type(await card().findByLabelText('Text'), 'Bitte leiser');
    await userEvent.click(card().getByRole('button', { name: 'Ausführen' }));
    expect(await card().findByText('Erledigt. Betroffene Verbindungen: 1')).toBeInTheDocument();
    expect(posted(fetchMock)).toEqual([{ type: 'poke', message: 'Bitte leiser' }]);
  });

  it('moves to a channel from the channel list', async () => {
    const fetchMock = setup();
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    await userEvent.click(await card().findByRole('radio', { name: 'Verschieben' }));
    const select = await card().findByLabelText('Ziel-Channel');
    await waitFor(() => {
      expect(within(select).getByRole('option', { name: 'AFK' })).toBeInTheDocument();
    });
    await userEvent.selectOptions(select, 'AFK');
    await userEvent.click(card().getByRole('button', { name: 'Ausführen' }));
    await waitFor(() => {
      expect(posted(fetchMock)).toEqual([{ type: 'move', channelId: 9 }]);
    });
  });

  it('bans with a template after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = setup();
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    await userEvent.click(await card().findByRole('radio', { name: 'Bannen' }));
    await userEvent.selectOptions(card().getByLabelText('Vorlage'), 'Cheating (dauerhaft)');
    await userEvent.click(card().getByRole('button', { name: 'Ausführen' }));
    expect(confirm).toHaveBeenCalledWith('Alice wirklich bannen (dauerhaft)?');
    expect(await card().findByText('Ban eingetragen.')).toBeInTheDocument();
    expect(posted(fetchMock)).toEqual([{ type: 'ban', templateId: 'cheating', includeIp: false }]);
  });

  it('does nothing when the confirmation is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    const fetchMock = setup();
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    await userEvent.click(await card().findByRole('radio', { name: 'Kicken' }));
    await userEvent.click(card().getByRole('button', { name: 'Ausführen' }));
    expect(posted(fetchMock)).toEqual([]);
  });

  it('offers only a UID ban for offline players', async () => {
    setup({ '/api/users/1': { ...sampleUser, online: null } });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(await card().findByText(/Der Spieler ist offline/)).toBeInTheDocument();
    expect(
      card()
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Bannen']);
    expect(card().queryByLabelText('Auch die aktuelle IP-Adresse sperren')).not.toBeInTheDocument();
  });

  it('points to the settings while switched off', async () => {
    setup({ '/api/settings/moderation': { ...settings, enabled: false } });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(
      await card().findByRole('link', { name: 'In den Einstellungen einschalten' }),
    ).toHaveAttribute('href', '/einstellungen');
  });

  it('is not shown to moderators', async () => {
    setup({ '/api/auth/me': { user: { id: 3, username: 'mod', role: 'moderator' } } });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(screen.queryByRole('heading', { level: 2, name: 'Moderation' })).not.toBeInTheDocument();
  });
});

describe('ModerationSettingsCard', () => {
  it('switches actions on and edits ban templates', async () => {
    const fetchMock = mockApi({
      '/api/settings/moderation': (_url: URL, init?: RequestInit) =>
        init?.method === 'PUT'
          ? { body: JSON.parse(init.body as string) as unknown }
          : { body: { ...settings, enabled: false } },
    });
    renderAt('/einstellungen');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Moderationsaktionen' });
    const form = within(heading.closest('form') as HTMLElement);
    await userEvent.click(form.getByRole('checkbox', { name: 'Moderationsaktionen erlauben' }));
    await userEvent.click(form.getByRole('button', { name: 'Vorlage „Spam“ entfernen' }));
    await userEvent.click(form.getByRole('button', { name: 'Vorlage hinzufügen' }));
    expect(form.getByRole('button', { name: 'Moderation speichern' })).toBeDisabled();
    const labels = form.getAllByLabelText('Bezeichnung');
    const reasons = form.getAllByLabelText('Grund');
    await userEvent.type(labels.at(-1) as HTMLElement, 'Werbung');
    await userEvent.type(reasons.at(-1) as HTMLElement, 'Werbung für andere Server');
    await userEvent.selectOptions(form.getAllByLabelText('Dauer').at(-1) as HTMLElement, '7 Tage');
    await userEvent.click(form.getByRole('button', { name: 'Moderation speichern' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(put?.[1]?.body as string)).toEqual({
        enabled: true,
        banTemplates: [
          { id: 'cheating', label: 'Cheating', reason: 'Cheating', durationS: 0 },
          {
            id: 'vorlage-2',
            label: 'Werbung',
            reason: 'Werbung für andere Server',
            durationS: 604_800,
          },
        ],
      });
    });
  });
});
