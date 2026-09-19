import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { PlayerRank } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const H = 3600;
const rank: PlayerRank = {
  enabled: true,
  dryRun: false,
  rankingS: 20 * H,
  target: { id: 1, name: 'Neuling' },
  next: { id: 2, name: 'Stammgast', remainingS: 30 * H },
  pending: true,
  skipped: null,
  frozen: false,
  override: null,
  ranks: [
    { id: 1, name: 'Neuling' },
    { id: 2, name: 'Stammgast' },
  ],
};

function card() {
  const heading = screen.getByRole('heading', { level: 2, name: 'Rang' });
  return within(heading.closest('section') as HTMLElement);
}

describe('PlayerRankCard', () => {
  it('shows rank, time to the next rank and the pending state', async () => {
    mockApi({
      '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } },
      '/api/users/1/rank': rank,
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(await card().findByText('Neuling')).toBeInTheDocument();
    expect(card().getByText('Nächster Rang: Stammgast in 30 h')).toBeInTheDocument();
    expect(card().getByText('wird beim nächsten Beitritt gesetzt')).toBeInTheDocument();
    expect(card().queryByRole('button', { name: 'Ausnahme speichern' })).not.toBeInTheDocument();
  });

  it('lets admins freeze a rank and add bonus hours', async () => {
    const fetchMock = mockApi({
      '/api/users/1/rank': rank,
      '/api/users/1/rank-override': (_url: URL, init?: RequestInit) => ({
        body: {
          ...rank,
          target: { id: 2, name: 'Stammgast' },
          frozen: true,
          next: null,
          override: {
            ...(JSON.parse(init?.body as string) as object),
            bonusS: 0,
            updatedAt: 1_789_000_000,
            updatedBy: 'admin',
          },
        },
      }),
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    await userEvent.selectOptions(await card().findByLabelText('Rang einfrieren'), 'Stammgast');
    const bonus = card().getByLabelText('Bonusstunden');
    await userEvent.clear(bonus);
    await userEvent.type(bonus, '-2,5');
    await userEvent.type(card().getByLabelText('Grund (intern)'), 'Turniersieger');
    await userEvent.click(card().getByRole('button', { name: 'Ausnahme speichern' }));
    expect(await card().findByText('eingefroren')).toBeInTheDocument();
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(put?.[1]?.body as string)).toEqual({
        frozenRankId: 2,
        bonusHours: -2.5,
        excluded: false,
        note: 'Turniersieger',
      });
    });
  });

  it('points admins to the rank setup when no ranks exist', async () => {
    mockApi({ '/api/users/1/rank': { ...rank, enabled: false } });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(await card().findByRole('link', { name: 'Ränge einrichten' })).toHaveAttribute(
      'href',
      '/raenge',
    );
  });
});
