import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt } from '../test-utils';

async function card() {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Achievements' });
  return within(heading.closest('section') as HTMLElement);
}

describe('PlayerAchievementsCard', () => {
  it('shows reached badges with tier, date and progress to the next tier', async () => {
    mockApi();
    renderAt('/spieler/1');
    const c = await card();
    const earned = await c.findByRole('list', { name: 'Achievements' });
    expect(within(earned).getByText('Stammgast')).toBeInTheDocument();
    expect(within(earned).getByText('Silber')).toBeInTheDocument();
    expect(within(earned).getByText('250 h von 500 h')).toBeInTheDocument();
    expect(within(earned).getByRole('progressbar', { name: 'Stammgast' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    // The secret one is neither counted nor listed while it is not reached.
    expect(c.getByText('1 von 2 erreicht')).toBeInTheDocument();
    expect(c.queryByText('Jubilar')).not.toBeInTheDocument();
  });

  it('lists open achievements on demand', async () => {
    mockApi();
    renderAt('/spieler/1');
    const c = await card();
    await userEvent.click(await c.findByText('Noch offen'));
    const open = c.getByRole('list', { name: 'Noch offen' });
    expect(within(open).getByText('Dauerbrenner')).toBeInTheDocument();
    expect(within(open).getByText('3 Tage von 7 Tage')).toBeInTheDocument();
  });

  it('marks backfilled tiers only when the shown tier was backfilled', async () => {
    mockApi({
      '/api/users/1/achievements': {
        achievements: [
          {
            id: 'pioneer',
            group: 'loyalty',
            unit: 'count',
            tiers: [1],
            secret: false,
            liveOnly: false,
            earned: [{ tier: 1, earnedAt: 1_700_000_000, backfilled: true }],
            value: 1,
            nextThreshold: null,
          },
        ],
      },
    });
    renderAt('/spieler/1');
    const c = await card();
    expect(await c.findByText('nachträglich erkannt')).toBeInTheDocument();
    expect(c.queryByRole('progressbar')).not.toBeInTheDocument();
  });
});
