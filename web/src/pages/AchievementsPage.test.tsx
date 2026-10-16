import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, requested } from '../test-utils';

describe('AchievementsPage', () => {
  it('shows achievements by group with holders and rarity', async () => {
    mockApi({ '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } } });
    renderAt('/achievements');
    const group = (await screen.findByRole('heading', { level: 2, name: 'Spielzeit' })).closest(
      'section',
    ) as HTMLElement;
    const g = within(group);
    expect(g.getByText('Stammgast')).toBeInTheDocument();
    expect(g.getByText(/Stufen: 10 h · 100 h · 500 h · 1\.000 h · 2\.500 h/)).toBeInTheDocument();
    expect(g.getByText(/120 Spieler/)).toBeInTheDocument();
    expect(g.getByText(/60 % der Spieler/)).toBeInTheDocument();
    expect(g.getByText(/Zuletzt: Alice/)).toBeInTheDocument();
    // Nobody has the secret one: name and description stay hidden.
    expect(screen.getByText('???')).toBeInTheDocument();
    expect(screen.queryByText('Jubilar')).not.toBeInTheDocument();
    expect(screen.getByText('Noch niemand.')).toBeInTheDocument();
  });

  it('loads the holders of an achievement on demand', async () => {
    const fetchMock = mockApi({
      '/api/achievements/regular': {
        achievementId: 'regular',
        total: 1,
        holders: [{ userId: 1, nickname: 'Alice', tier: 2, earnedAt: 1_789_790_000 }],
      },
    });
    renderAt('/achievements');
    await userEvent.click(await screen.findByRole('button', { name: 'Inhaber anzeigen' }));
    const row = await screen.findByRole('link', { name: 'Alice' });
    expect(row).toHaveAttribute('href', '/spieler/1');
    expect(requested(fetchMock, '/api/achievements/regular')[0]?.searchParams.get('page')).toBe(
      '1',
    );
  });

  it('is in the navigation for every role', async () => {
    mockApi({ '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } } });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).getByRole('link', { name: 'Achievements' })).toHaveAttribute(
      'href',
      '/achievements',
    );
  });

  it('shows the latest arrivals on the dashboard', async () => {
    mockApi();
    renderAt('/');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Zuletzt erreicht' });
    const tile = within(heading.closest('section') as HTMLElement);
    expect(await tile.findByRole('link', { name: 'Alice' })).toBeInTheDocument();
    expect(tile.getByText('hat „Stammgast (Silber)“ erreicht')).toBeInTheDocument();
  });
});

describe('AchievementSettingsCard', () => {
  it('switches achievements on and off', async () => {
    const fetchMock = mockApi({
      '/api/settings/achievements': (_url: URL, init?: RequestInit) => ({
        body: {
          disabled:
            init?.method === 'PUT'
              ? (JSON.parse(init.body as string) as { disabled: string[] }).disabled
              : ['jubilee'],
          catalog: [
            {
              id: 'regular',
              group: 'playtime',
              unit: 'seconds',
              tiers: [36_000],
              secret: false,
              liveOnly: false,
            },
            {
              id: 'jubilee',
              group: 'secret',
              unit: 'count',
              tiers: [1000],
              secret: true,
              liveOnly: false,
            },
          ],
          state: null,
        },
      }),
    });
    renderAt('/einstellungen');
    const heading = await screen.findByRole('heading', { level: 2, name: 'Achievements' });
    const form = within(heading.closest('form') as HTMLElement);
    expect(form.getByRole('checkbox', { name: 'Stammgast' })).toBeChecked();
    const jubilee = form.getByRole('checkbox', { name: /Jubilar/ });
    expect(jubilee).not.toBeChecked();
    await userEvent.click(jubilee);
    await userEvent.click(form.getByRole('checkbox', { name: 'Stammgast' }));
    await userEvent.click(form.getByRole('button', { name: 'Speichern' }));
    expect(await form.findByRole('status')).toHaveTextContent('Gespeichert');
    // The only write on the page so far.
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(put?.[1]?.body as string)).toEqual({ disabled: ['regular'] });
  });
});
