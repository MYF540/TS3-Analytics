import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, sampleNetworkSettings } from '../test-utils';

function card() {
  const heading = screen.getByRole('heading', { level: 2, name: 'Spieler-Netzwerk' });
  return within(heading.closest('form') as HTMLElement);
}

describe('NetworkSettingsCard', () => {
  it('shows the settings and marks AFK channels as always excluded', async () => {
    mockApi();
    renderAt('/einstellungen');
    await screen.findByRole('heading', { level: 2, name: 'Spieler-Netzwerk' });
    expect(card().getByLabelText('Anzahl berücksichtigter Spieler')).toHaveValue(200);
    expect(card().getByLabelText('Mindestdauer einer Begegnung (Minuten)')).toHaveValue(5);
    expect(card().getByLabelText('Mindestzeit je Paar insgesamt (Minuten)')).toHaveValue(30);
    const afk = card().getByRole('checkbox', { name: /AFK/ });
    expect(afk).toBeChecked();
    expect(afk).toBeDisabled();
    expect(card().getByText('Das Netz wurde noch nicht berechnet.')).toBeInTheDocument();
  });

  it('saves excluded channels and the thresholds', async () => {
    const fetchMock = mockApi();
    renderAt('/einstellungen');
    await screen.findByRole('heading', { level: 2, name: 'Spieler-Netzwerk' });
    await userEvent.click(card().getByRole('checkbox', { name: 'Gaming' }));
    const minPair = card().getByLabelText('Mindestzeit je Paar insgesamt (Minuten)');
    await userEvent.clear(minPair);
    await userEvent.type(minPair, '60');
    await userEvent.click(card().getByRole('button', { name: 'Speichern' }));

    await waitFor(() => {
      const put = fetchMock.mock.calls.find(
        ([input, init]) =>
          (input as string).includes('/settings/network') && init?.method === 'PUT',
      );
      expect(JSON.parse(put?.[1]?.body as string)).toEqual({
        excludedChannelIds: [3],
        candidates: 200,
        minEncounterS: 300,
        minPairS: 3600,
      });
    });
  });

  it('refuses a candidate count outside the allowed range', async () => {
    mockApi();
    renderAt('/einstellungen');
    await screen.findByRole('heading', { level: 2, name: 'Spieler-Netzwerk' });
    const candidates = card().getByLabelText('Anzahl berücksichtigter Spieler');
    await userEvent.clear(candidates);
    await userEvent.type(candidates, '5');
    expect(card().getByRole('button', { name: 'Speichern' })).toBeDisabled();
    expect(candidates).toHaveAttribute('aria-invalid', 'true');
  });

  it('runs the job on demand', async () => {
    const fetchMock = mockApi({
      '/api/settings/network/run': {
        ...sampleNetworkSettings,
        state: {
          computedAt: 1_789_800_000,
          seconds: 1.5,
          ranges: { '30d': { nodes: 42, edges: 96, droppedPairs: 3, from: 1, to: 2 } },
        },
      },
    });
    renderAt('/einstellungen');
    await screen.findByRole('heading', { level: 2, name: 'Spieler-Netzwerk' });
    await userEvent.click(card().getByRole('button', { name: 'Jetzt neu berechnen' }));
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(([input]) => (input as string).includes('/settings/network/run')),
      ).toBe(true);
    });
    expect(await card().findByText('Netz neu berechnet.')).toBeInTheDocument();
  });

  it('reports when the network was last computed', async () => {
    mockApi({
      '/api/settings/network': {
        ...sampleNetworkSettings,
        state: {
          computedAt: 1_789_800_000,
          seconds: 2.4,
          ranges: { '30d': { nodes: 42, edges: 96, droppedPairs: 3, from: 1, to: 2 } },
        },
      },
    });
    renderAt('/einstellungen');
    await screen.findByRole('heading', { level: 2, name: 'Spieler-Netzwerk' });
    expect(card().getByText(/42 Spieler, 96 Verbindungen/)).toBeInTheDocument();
  });
});
