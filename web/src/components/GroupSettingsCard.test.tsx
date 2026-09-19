import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt } from '../test-utils';

function card() {
  const heading = screen.getByRole('heading', { level: 2, name: 'Servergruppen-Überwachung' });
  return within(heading.closest('section') as HTMLElement);
}

describe('GroupSettingsCard', () => {
  it('selects protected groups and shows recent changes', async () => {
    const fetchMock = mockApi({
      '/api/settings/groups': (_url: URL, init?: RequestInit) =>
        init?.method === 'PUT'
          ? {
              body: {
                ...(JSON.parse(init.body as string) as object),
                knownGroups: [
                  { id: 6, name: 'Server Admin' },
                  { id: 8, name: 'Guest' },
                ],
              },
            }
          : {
              body: {
                protectedGroupIds: [42],
                knownGroups: [
                  { id: 6, name: 'Server Admin' },
                  { id: 8, name: 'Guest' },
                ],
              },
            },
      '/api/group-changes': {
        items: [
          {
            id: 1,
            at: 1_789_000_000,
            action: 'added',
            userId: 5,
            nickname: 'Bob',
            groupId: 6,
            groupName: 'Server Admin',
            invokerName: 'Admin',
            protected: true,
          },
        ],
        total: 1,
        page: 1,
        pageSize: 20,
      },
    });
    renderAt('/einstellungen');
    await screen.findByRole('heading', { level: 2, name: 'Servergruppen-Überwachung' });
    // A protected id that no longer exists stays visible so it can be removed.
    expect(await card().findByRole('checkbox', { name: '#42' })).toBeChecked();
    await userEvent.click(card().getByRole('checkbox', { name: 'Server Admin' }));
    await userEvent.click(card().getByRole('checkbox', { name: '#42' }));
    await userEvent.click(card().getByRole('button', { name: 'Gruppen speichern' }));
    await waitFor(() => {
      const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
      expect(JSON.parse(put?.[1]?.body as string)).toEqual({ protectedGroupIds: [6] });
    });
    expect(card().getByRole('link', { name: 'Bob' })).toHaveAttribute('href', '/spieler/5');
    expect(card().getByText('+ Server Admin')).toBeInTheDocument();
    expect(card().getByText('geschützt')).toBeInTheDocument();
  });
});
