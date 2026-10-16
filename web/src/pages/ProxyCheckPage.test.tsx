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
    invite: {
      whitelistGroupId: null,
      sponsorGroupIds: [],
      timeoutS: 300,
      maxAttempts: 3,
      intro: 'Zu wem gehörst du?',
      nobodyMessage: 'Niemand da.',
      askedMessage: '{name} wurde gefragt.',
      sponsorQuestion: 'Gehört {name} zu dir? {yes} oder {no}.',
      yesWord: 'ja',
      noWord: 'nein',
      acceptedMessage: 'Freigeschaltet.',
      declinedMessage: 'Abgelehnt.',
      timeoutMessage: 'Keine Antwort.',
      exhaustedMessage: 'Zu viele Versuche.',
      sponsorThanks: 'Danke.',
    },
    english: {
      enabled: false,
      message: 'VPN or proxy detected.',
      invite: {
        intro: 'Who do you belong to?',
        nobodyMessage: 'Nobody here.',
        askedMessage: '{name} has been asked.',
        sponsorQuestion: 'Does {name} belong to you? {yes} or {no}.',
        yesWord: 'yes',
        noWord: 'no',
        acceptedMessage: 'Unlocked.',
        declinedMessage: 'Declined.',
        timeoutMessage: 'No answer.',
        exhaustedMessage: 'Too many attempts.',
        sponsorThanks: 'Thank you.',
      },
    },
  },
  groups: [
    { id: 6, name: 'Server Admin' },
    { id: 50, name: 'VPN' },
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
    await userEvent.selectOptions(screen.getByLabelText('Servergruppe für erkannte Spieler'), '50');
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
      groupId: 50,
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

  it('saves the invite flow with both groups and who may vouch', async () => {
    const { saved } = setup({
      ...stored,
      groups: [...stored.groups, { id: 51, name: 'Freigegeben' }],
    });
    await userEvent.selectOptions(
      await screen.findByLabelText('Was soll bei einem Treffer passieren?'),
      'invite',
    );
    expect(save()).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('Einschränkende Servergruppe'), '50');
    const box = within(screen.getByRole('group', { name: 'Einladung durch einen Bürgen' }));
    await userEvent.selectOptions(box.getByLabelText('Freigabe-Gruppe nach der Bestätigung'), '50');
    expect(save()).toBeDisabled();
    await userEvent.selectOptions(box.getByLabelText('Freigabe-Gruppe nach der Bestätigung'), '51');
    await userEvent.click(
      within(box.getByRole('list', { name: 'Gruppen, die bürgen dürfen' })).getByLabelText(
        'Server Admin',
      ),
    );
    const timeout = box.getByLabelText('Zeit für die Antwort des Bürgen (Sekunden)');
    await userEvent.clear(timeout);
    expect(save()).toBeDisabled();
    await userEvent.type(timeout, '120');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toEqual({
      ...stored.settings,
      action: 'invite',
      groupId: 50,
      invite: {
        ...stored.settings.invite,
        whitelistGroupId: 51,
        sponsorGroupIds: [6],
        timeoutS: 120,
      },
    });
  });

  it('saves English invite texts and refuses a word that means yes and no', async () => {
    const { saved } = setup({
      ...stored,
      settings: { ...stored.settings, action: 'invite', groupId: 50 },
    });
    const english = within(await screen.findByRole('group', { name: 'Englische Texte' }));
    await userEvent.click(english.getByLabelText(/englischen Texte schicken/));
    expect(english.getByText(/in beiden Sprachen verstanden/)).toBeInTheDocument();
    const yes = english.getByLabelText('Wort zum Bestätigen');
    await userEvent.clear(yes);
    await userEvent.type(yes, 'nein');
    expect(screen.getByText(/müssen sich unterscheiden/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await userEvent.clear(yes);
    await userEvent.type(yes, 'sure');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toMatchObject({
      invite: { yesWord: 'ja', noWord: 'nein' },
      english: { enabled: true, invite: { ...stored.settings.english.invite, yesWord: 'sure' } },
    });
  });

  it('hides the invite settings for the other actions', async () => {
    setup();
    await screen.findByLabelText('Was soll bei einem Treffer passieren?');
    expect(screen.queryByRole('group', { name: 'Einladung durch einen Bürgen' })).toBeNull();
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
      '/api/users/1/proxy': {
        enabled: true,
        verdict: 'proxy',
        checkedAt: 1_789_800_000,
        vouch: null,
      },
    });
    renderAt('/spieler/1');
    expect(await screen.findByText(/^Zuletzt über VPN oder Proxy verbunden/)).toBeInTheDocument();
  });

  it('names who vouched for the player', async () => {
    mockApi({
      '/api/users/1/proxy': {
        enabled: true,
        verdict: 'proxy',
        checkedAt: 1_789_800_000,
        vouch: { sponsorUserId: 5, sponsorNickname: 'Anna', at: 1_789_800_100 },
      },
    });
    renderAt('/spieler/1');
    expect(await screen.findByRole('link', { name: 'Anna' })).toHaveAttribute('href', '/spieler/5');
    expect(screen.getByText(/Gebürgt hat/)).toBeInTheDocument();
  });

  it('says nothing for a clean player', async () => {
    mockApi({
      '/api/users/1/proxy': {
        enabled: true,
        verdict: 'clean',
        checkedAt: 1_789_800_000,
        vouch: null,
      },
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/VPN oder Proxy/)).not.toBeInTheDocument();
  });
});
