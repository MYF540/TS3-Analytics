import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt } from '../test-utils';

function card() {
  const heading = screen.getByRole('heading', { level: 2, name: 'Datenschutz' });
  return within(heading.closest('section') as HTMLElement);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PrivacyCard', () => {
  it('offers the export and refuses a wrong UID without asking the server', async () => {
    const fetchMock = mockApi();
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(card().getByRole('link', { name: 'Alle Daten als JSON exportieren' })).toHaveAttribute(
      'href',
      '/api/users/1/export',
    );
    await userEvent.type(card().getByLabelText('Zur Sicherheit die UID eintippen'), 'falsch');
    await userEvent.click(card().getByRole('button', { name: 'Spieler anonymisieren' }));
    expect(await card().findByRole('alert')).toHaveTextContent(
      'Die eingegebene UID passt nicht zu diesem Spieler.',
    );
    expect(fetchMock.mock.calls.some(([input]) => (input as string).includes('anonymize'))).toBe(
      false,
    );
  });

  it('anonymizes after confirmation and returns to the player list', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = mockApi({
      '/api/users/1/anonymize': { nicknames: 2, ipSeen: 3, notes: 1, flags: 0 },
    });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    await userEvent.type(card().getByLabelText('Zur Sicherheit die UID eintippen'), 'uid-alice=');
    await userEvent.click(card().getByRole('button', { name: 'Spieler anonymisieren' }));
    expect(confirm).toHaveBeenCalledWith('Daten von „Alice“ endgültig anonymisieren?');
    await waitFor(() => {
      expect(screen.getByRole('heading', { level: 1, name: 'Spieler' })).toBeInTheDocument();
    });
    const post = fetchMock.mock.calls.find(([input]) => (input as string).includes('anonymize'));
    expect(JSON.parse(post?.[1]?.body as string)).toEqual({ confirmUid: 'uid-alice=' });
  });

  it('is hidden from moderators', async () => {
    mockApi({ '/api/auth/me': { user: { id: 3, username: 'mod', role: 'moderator' } } });
    renderAt('/spieler/1');
    await screen.findByRole('heading', { level: 1, name: 'Alice' });
    expect(
      screen.queryByRole('heading', { level: 2, name: 'Datenschutz' }),
    ).not.toBeInTheDocument();
  });
});
