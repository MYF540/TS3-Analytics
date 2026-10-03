import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { RulesSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const stored: RulesSettings = {
  settings: {
    enabled: false,
    dryRun: true,
    exemptGroupIds: [],
    version: 3,
    rules: ['Seid freundlich.', 'Kein Spam.'],
    trigger: 'join',
    ruleChannelId: null,
    viaChat: true,
    acceptCommand: 'akzeptieren',
    declineCommand: 'ablehnen',
    viaChannel: false,
    acceptChannelId: null,
    returnChannelId: null,
    prompt: 'Antworte mit {accept} oder {decline}.',
    acceptedMessage: 'Danke.',
    declinedMessage: 'Schade.',
    acceptedGroupId: null,
    kickOnDecline: false,
    deadlineS: 0,
    kickReason: 'Regeln nicht bestätigt',
  },
  groups: [{ id: 20, name: 'Mitglied' }],
  channels: [
    { id: 40, name: 'Regeln' },
    { id: 41, name: 'Regeln akzeptieren' },
  ],
  stats: { accepted: 120, declined: 4 },
};

function setup(overrides: Record<string, unknown> = {}) {
  const fetchMock = mockApi({
    '/api/automation/rules': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...stored, settings: JSON.parse(init.body as string) as unknown }
          : stored,
    }),
    ...overrides,
  });
  renderAt('/automatik/rules');
  const saved = (): RulesSettings['settings'] | undefined => {
    const call = fetchMock.mock.calls.findLast(([, init]) => init?.method === 'PUT');
    return call ? (JSON.parse(call[1]?.body as string) as RulesSettings['settings']) : undefined;
  };
  return { saved };
}

const save = () => screen.getByRole('button', { name: 'Speichern' });

describe('RulesPage', () => {
  it('shows the rules as one text with version and counts', async () => {
    setup();
    expect(await screen.findByLabelText('Regeltext')).toHaveValue('Seid freundlich.\n\nKein Spam.');
    expect(screen.getByText('Aktuelle Version: 3')).toBeInTheDocument();
    expect(screen.getByText('– bestätigt: 120, abgelehnt: 4')).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });

  it('splits the text into messages at blank lines when saving', async () => {
    const { saved } = setup();
    await userEvent.type(await screen.findByLabelText('Regeltext'), '\n\nViel Spaß!');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toEqual({
      ...stored.settings,
      rules: ['Seid freundlich.', 'Kein Spam.', 'Viel Spaß!'],
    });
  });

  it('raises the version once per save', async () => {
    const { saved } = setup();
    const button = await screen.findByRole('button', { name: /Neue Version/ });
    await userEvent.click(button);
    expect(screen.getByText('Aktuelle Version: 4')).toBeInTheDocument();
    expect(button).toBeDisabled();
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()?.version).toBe(4);
    expect(button).toBeEnabled();
  });

  it('saves confirmation by channel, group, deadline and kick', async () => {
    const { saved } = setup();
    await userEvent.click(await screen.findByLabelText('Durch Betreten eines Channels'));
    await userEvent.selectOptions(screen.getByLabelText('Bestätigungs-Channel'), '41');
    await userEvent.selectOptions(
      screen.getByLabelText('Servergruppe für alle, die bestätigt haben'),
      '20',
    );
    await userEvent.click(screen.getByLabelText('Wer ablehnt, wird vom Server gekickt'));
    const deadline = screen.getByLabelText(/Frist für die Entscheidung/);
    await userEvent.clear(deadline);
    await userEvent.type(deadline, '5');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toMatchObject({
      viaChannel: true,
      acceptChannelId: 41,
      returnChannelId: null,
      acceptedGroupId: 20,
      kickOnDecline: true,
      deadlineS: 300,
    });
  });

  it('cannot be switched on without a way to confirm or with equal words', async () => {
    setup();
    await userEvent.click(await screen.findByLabelText('Modul einschalten'));
    expect(save()).toBeEnabled();
    await userEvent.click(screen.getByLabelText('Per Antwort an den Bot'));
    expect(screen.getByText(/Mindestens ein Weg zur Bestätigung/)).toBeInTheDocument();
    expect(save()).toBeDisabled();

    await userEvent.click(screen.getByLabelText('Per Antwort an den Bot'));
    await userEvent.clear(screen.getByLabelText('Wort zum Ablehnen'));
    await userEvent.type(screen.getByLabelText('Wort zum Ablehnen'), 'AKZEPTIEREN');
    expect(save()).toBeDisabled();
  });

  it('asks for the rule channel when the rules are sent there', async () => {
    const { saved } = setup();
    await userEvent.selectOptions(await screen.findByLabelText('Regeln schicken'), 'channel');
    await userEvent.selectOptions(screen.getByLabelText('Regel-Channel'), '40');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toMatchObject({ trigger: 'channel', ruleChannelId: 40 });
  });
});

describe('PlayerRulesNotice', () => {
  const rules = (state: unknown, enabled = true) => ({
    '/api/users/1/rules': { enabled, currentVersion: 2, state },
  });

  it('tells whether the player confirmed the current rules', async () => {
    mockApi(rules({ version: 2, decision: 'accepted', at: 1_789_800_000 }));
    renderAt('/spieler/1');
    expect(await screen.findByText(/^Serverregeln bestätigt am/)).toBeInTheDocument();
  });

  it('points out an outdated confirmation and a refusal', async () => {
    mockApi(rules({ version: 1, decision: 'accepted', at: 1_789_800_000 }));
    renderAt('/spieler/1');
    expect(await screen.findByText(/die aktuelle Version steht noch aus/)).toBeInTheDocument();
  });

  it('says nothing while the module is off', async () => {
    mockApi(rules(null, false));
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByText(/Serverregeln/)).not.toBeInTheDocument();
  });
});
