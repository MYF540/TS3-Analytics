import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { AlertSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const configured: AlertSettings = {
  configured: true,
  webhookHint: '…Ab3x',
  events: ['flag.high', 'bot.connection'],
  ratePerMinute: 10,
  joinSpike: { windowMinutes: 10, threshold: 10 },
};

function card() {
  const heading = screen.getByRole('heading', { level: 2, name: 'Discord-Benachrichtigungen' });
  const form = heading.closest('form');
  if (!form) throw new Error('alerts card missing');
  return within(form);
}

function setup(initial: AlertSettings, test: object = { ok: true, status: null }) {
  return mockApi({
    '/api/settings/activity': {
      settings: { idleThresholdS: 600, afkChannelIds: [], awayIsAfk: true, outputMutedIsAfk: true },
      defaults: { idleThresholdS: 600, afkChannelIds: [], awayIsAfk: true, outputMutedIsAfk: true },
      channels: [],
    },
    '/api/settings/alerts': (_url: URL, init?: RequestInit) => {
      if (init?.method !== 'PUT') return { body: initial };
      const body = JSON.parse(init.body as string) as {
        webhookUrl?: string | null;
        events: string[];
        ratePerMinute: number;
      };
      const removed = body.webhookUrl === null;
      return {
        body: {
          configured: removed ? false : body.webhookUrl !== undefined || initial.configured,
          webhookHint: removed ? null : '…Zz99',
          events: body.events,
          ratePerMinute: body.ratePerMinute,
          joinSpike: initial.joinSpike,
        },
      };
    },
    '/api/settings/alerts/test': test,
  });
}

function puts(fetchMock: ReturnType<typeof mockApi>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([, init]) => JSON.parse(init?.body as string) as Record<string, unknown>);
}

describe('AlertSettingsCard', () => {
  it('shows only the masked webhook and the selected events', async () => {
    setup(configured);
    renderAt('/einstellungen');
    await screen.findByText('Webhook eingerichtet (endet auf …Ab3x)');
    expect(card().getByLabelText('Webhook-URL')).toHaveValue('');
    expect(card().getByLabelText('Webhook-URL')).toHaveAttribute('type', 'password');
    expect(card().getByRole('checkbox', { name: /Stufe „hoch“/ })).toBeChecked();
    expect(card().getByRole('checkbox', { name: /Neuer Ban/ })).not.toBeChecked();
  });

  it('saves without resending the stored webhook', async () => {
    const fetchMock = setup(configured);
    renderAt('/einstellungen');
    await screen.findByText(/Webhook eingerichtet/);
    await userEvent.click(card().getByRole('checkbox', { name: /Neuer Ban/ }));
    await userEvent.click(card().getByRole('button', { name: 'Benachrichtigungen speichern' }));
    await waitFor(() => {
      expect(puts(fetchMock)).toEqual([
        {
          events: ['flag.high', 'ban.added', 'bot.connection'],
          ratePerMinute: 10,
          joinSpike: { windowMinutes: 10, threshold: 10 },
        },
      ]);
    });
    expect(await card().findByText('Gespeichert.')).toBeInTheDocument();
  });

  it('sets a new webhook, clears the field and can remove it', async () => {
    const fetchMock = setup({ ...configured, configured: false, webhookHint: null });
    renderAt('/einstellungen');
    await screen.findByText('Noch kein Webhook eingerichtet.');
    expect(card().getByRole('button', { name: 'Test-Nachricht senden' })).toBeDisabled();
    const url = 'https://discord.com/api/webhooks/1/abc';
    await userEvent.type(card().getByLabelText('Webhook-URL'), url);
    await userEvent.click(card().getByRole('button', { name: 'Benachrichtigungen speichern' }));
    expect(await card().findByText('Webhook eingerichtet (endet auf …Zz99)')).toBeInTheDocument();
    expect(card().getByLabelText('Webhook-URL')).toHaveValue('');
    expect(puts(fetchMock)[0]).toMatchObject({ webhookUrl: url });

    await userEvent.click(card().getByRole('button', { name: 'Webhook entfernen' }));
    expect(await card().findByText('Noch kein Webhook eingerichtet.')).toBeInTheDocument();
    expect(puts(fetchMock)[1]).toMatchObject({ webhookUrl: null });
  });

  it('reports the result of a test message', async () => {
    setup(configured, { ok: false, status: 404 });
    renderAt('/einstellungen');
    await screen.findByText(/Webhook eingerichtet/);
    await userEvent.click(card().getByRole('button', { name: 'Test-Nachricht senden' }));
    expect(await card().findByRole('alert')).toHaveTextContent(
      'Discord hat die Nachricht abgelehnt (HTTP 404).',
    );
  });

  it('rejects an invalid rate', async () => {
    setup(configured);
    renderAt('/einstellungen');
    await screen.findByText(/Webhook eingerichtet/);
    const rate = card().getByLabelText('Höchstens Meldungen pro Minute');
    await userEvent.clear(rate);
    await userEvent.type(rate, '99');
    expect(card().getByRole('button', { name: 'Benachrichtigungen speichern' })).toBeDisabled();
  });
});
