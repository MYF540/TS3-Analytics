import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { SpamRules, SpamSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const rules = (changes: Partial<SpamRules> = {}): SpamRules => ({
  enabled: false,
  windowS: 10,
  warnAt: 6,
  kickAt: 10,
  banAt: 0,
  banDurationS: 600,
  warnBy: 'poke',
  warnMessage: 'Bitte langsamer.',
  reason: 'Spam',
  ...changes,
});

const stored: SpamSettings = {
  settings: {
    enabled: false,
    dryRun: true,
    exemptGroupIds: [],
    channelSwitch: rules(),
    channelCreate: rules({ windowS: 60, warnAt: 3, kickAt: 5 }),
    nickname: rules({ windowS: 600, warnAt: 3, kickAt: 5 }),
    reconnect: rules({ windowS: 300, warnAt: 0, kickAt: 0, banAt: 8 }),
    lobby: rules({ windowS: 60, warnAt: 3, kickAt: 6 }),
    english: {
      enabled: false,
      channelSwitch: { warnMessage: 'Please slow down.', reason: 'Spam: switching channels' },
      channelCreate: { warnMessage: 'Please slow down.', reason: 'Spam: creating channels' },
      nickname: { warnMessage: 'Please slow down.', reason: 'Spam: nickname' },
      reconnect: { warnMessage: 'Please slow down.', reason: 'Spam: reconnecting' },
      lobby: { warnMessage: 'Please slow down.', reason: 'Spam: private channels' },
    },
  },
  groups: [{ id: 6, name: 'Server Admin' }],
};

function setup() {
  const fetchMock = mockApi({
    '/api/automation/spam': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...stored, settings: JSON.parse(init.body as string) as unknown }
          : stored,
    }),
  });
  renderAt('/automatik/spam');
  const saved = (): SpamSettings['settings'] | undefined => {
    const call = fetchMock.mock.calls.findLast(([, init]) => init?.method === 'PUT');
    return call ? (JSON.parse(call[1]?.body as string) as SpamSettings['settings']) : undefined;
  };
  return { saved };
}

const save = () => screen.getByRole('button', { name: 'Speichern' });
const kind = (name: string) => within(screen.getByRole('group', { name }));

async function setNumber(box: ReturnType<typeof kind>, label: string, value: string) {
  const input = box.getByLabelText(label);
  await userEvent.clear(input);
  await userEvent.type(input, value);
}

describe('SpamControlPage', () => {
  it('shows every kind with its own window and thresholds', async () => {
    setup();
    await screen.findByRole('group', { name: 'Channel-Wechsel' });
    expect(kind('Channel-Wechsel').getByLabelText('Zeitfenster (Sekunden)')).toHaveValue(10);
    expect(kind('Schnelles Neuverbinden').getByLabelText('Ban ab')).toHaveValue(8);
    expect(kind('Nickname ändern').getByLabelText('Zeitfenster (Sekunden)')).toHaveValue(600);
    expect(save()).toBeDisabled();
  });

  it('saves one kind without touching the others', async () => {
    const { saved } = setup();
    await screen.findByRole('group', { name: 'Channel-Wechsel' });
    const box = kind('Channel-Wechsel');
    await userEvent.click(box.getByLabelText('Diese Art überwachen'));
    await setNumber(box, 'Ban ab', '15');
    await setNumber(box, 'Dauer des Bans (Minuten)', '30');
    await userEvent.selectOptions(box.getByLabelText('Verwarnen per'), 'message');
    await userEvent.click(save());
    await screen.findByText('Gespeichert.');
    expect(saved()).toEqual({
      ...stored.settings,
      channelSwitch: rules({ enabled: true, banAt: 15, banDurationS: 1800, warnBy: 'message' }),
    });
  });

  it('wants rising thresholds', async () => {
    setup();
    await screen.findByRole('group', { name: 'Channel-Wechsel' });
    const box = kind('Channel-Wechsel');
    await setNumber(box, 'Kick ab', '4');
    expect(box.getByText(/müssen von Verwarnung über Kick zu Ban ansteigen/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
    await setNumber(box, 'Verwarnung ab', '0');
    expect(box.queryByText(/ansteigen/)).not.toBeInTheDocument();
    expect(save()).toBeEnabled();
  });

  it('wants at least one step for a kind that is watched', async () => {
    setup();
    await screen.findByRole('group', { name: 'Schnelles Neuverbinden' });
    const box = kind('Schnelles Neuverbinden');
    await userEvent.click(box.getByLabelText('Diese Art überwachen'));
    await setNumber(box, 'Ban ab', '0');
    expect(box.getByText(/Mindestens eine Stufe/)).toBeInTheDocument();
    expect(save()).toBeDisabled();
  });
});
