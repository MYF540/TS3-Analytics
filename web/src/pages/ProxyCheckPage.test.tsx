import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { ProxySettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const stored: ProxySettings = {
  settings: {
    enabled: false,
    dryRun: true,
    exemptGroupIds: [],
    action: 'none',
    message: 'VPN oder Proxy erkannt.',
    groupId: null,
    banDurationS: 3600,
    notifyGroupIds: [],
    notifyMessage: 'VPN/Proxy erkannt bei {name}.',
    exemptUserIds: [],
  },
  groups: [
    { id: 6, name: 'Server Admin' },
    { id: 142, name: 'VPN' },
  ],
  keyConfigured: true,
  stats: { listed: 12, clean: 340, proxy: 2 },
  flagged: [{ userId: 7, nickname: 'Evader', checkedAt: 1_789_800_000 }],
};

function setup(initial: ProxySettings = stored) {
  const fetchMock = mockApi({
    '/api/automation/proxy': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...initial, settings: JSON.parse(init.body as string) as unknown }
          : initial,
    }),
    '/api/automation/proxy/clear/7': { removed: 1 },
  });
  renderAt('/automatik/proxy');
  const saved = (): ProxySettings['settings'] | undefined => {
    const call = fetchMock.mock.calls.findLast(([, init]) => init?.method === 'PUT');
    return call ? (JSON.parse(call[1]?.body as string) as ProxySettings['settings']) : undefined;
  };
  const posted = () =>
    fetchMock.mock.calls
      .filter(([, init]) => init?.method === 'POST')
      .map(([input]) => input as string);
  return { saved, posted };
}

const save = () => screen.getByRole('button', { name: 'Speichern' });

describe('ProxyCheckPage', () => {
  it('says plainly that addresses go to a third party, and shows the counts', async () => {
    setup();
    expect(await screen.findByText(/an den Dienst proxycheck.io übermittelt/)).toBeInTheDocument();
    expect(
      screen.getByText(
        'Adressen auf der lokalen Liste: 12 · geprüft ohne Befund: 340 · mit Befund: 2',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/kein PROXYCHECK_API_KEY/)).not.toBeInTheDocument();
  });

  it('points out a missing API key', async () => {
    setup({ ...stored, keyConfigured: false });
    expect(await screen.findByText(/kein PROXYCHECK_API_KEY/)).toBeInTheDocument();
  });

  it('saves the group action with its group, team notice and exempt players', async () => {
    const { saved } = setup();
    await userEvent.selectOptions(
      await screen.findByLabelText('Was soll bei einem Treffer passieren?'),
      'group',
    );
    expect(save()).toBeDisabled();
    await userEvent.selectOptions(
      screen.getByLabelText('Servergruppe für erkannte Spieler'),
      '142',
    );
    await userEvent.click(
      within(screen.getByRole('list', { name: 'Team benachrichtigen' })).getByLabelText(
        'Server Admin',
      ),
    );
    await userEvent.type(screen.getByLabelText(/Spieler, die nie geprüft werden/), '42, 7 42');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toEqual({
      ...stored.settings,
      action: 'group',
      groupId: 142,
      notifyGroupIds: [6],
      exemptUserIds: [42, 7],
    });
  });

  it('saves a ban with its duration and rejects nonsense in the id list', async () => {
    const { saved } = setup();
    await userEvent.selectOptions(
      await screen.findByLabelText('Was soll bei einem Treffer passieren?'),
      'ban',
    );
    const minutes = screen.getByLabelText('Dauer des Bans (Minuten)');
    await userEvent.clear(minutes);
    await userEvent.type(minutes, '120');
    const ids = screen.getByLabelText(/Spieler, die nie geprüft werden/);
    await userEvent.type(ids, 'abc');
    expect(save()).toBeDisabled();
    await userEvent.clear(ids);
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toMatchObject({ action: 'ban', banDurationS: 7200 });
  });

  it('marks a flagged player as clean', async () => {
    const { posted } = setup();
    expect(await screen.findByRole('link', { name: 'Evader' })).toHaveAttribute(
      'href',
      '/spieler/7',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Evader als sauber markieren' }));
    expect(await screen.findByText('Als sauber markiert.')).toBeInTheDocument();
    expect(posted()).toEqual(['/api/automation/proxy/clear/7']);
  });
});

describe('PlayerProxyNotice', () => {
  it('warns on the player page when a VPN or proxy was seen', async () => {
    mockApi({
      '/api/users/1/proxy': { enabled: true, verdict: 'proxy', checkedAt: 1_789_800_000 },
    });
    renderAt('/spieler/1');
    expect(await screen.findByText(/^Zuletzt über VPN oder Proxy verbunden/)).toBeInTheDocument();
  });

  it('says nothing for a clean player', async () => {
    mockApi({
      '/api/users/1/proxy': { enabled: true, verdict: 'clean', checkedAt: 1_789_800_000 },
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/VPN oder Proxy/)).not.toBeInTheDocument();
  });
});
