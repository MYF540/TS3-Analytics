import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockApi, renderAt, sampleNotes } from '../test-utils';

const asViewer = { '/api/auth/me': { user: { id: 2, username: 'gast', role: 'viewer' } } };

async function notesCard() {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Notizen' });
  const card = heading.closest('section');
  if (!card) throw new Error('notes card missing');
  await within(card).findByText('Organisiert die Turniere');
  return within(card);
}

function calls(fetchMock: ReturnType<typeof mockApi>, method: string, path: string) {
  return fetchMock.mock.calls.filter(
    ([input, init]) =>
      (init?.method ?? 'GET') === method && new URL(input as string, 'http://x').pathname === path,
  );
}

function sentBody(call: unknown[] | undefined): unknown {
  const init = call?.[1] as RequestInit | undefined;
  return JSON.parse(init?.body as string);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('player notes', () => {
  it('lists notes with author, edit marker and history', async () => {
    mockApi({
      '/api/notes/7/revisions': {
        revisions: [{ body: 'Alte Fassung', editorName: 'admin', replacedAt: 1_789_750_000 }],
      },
    });
    renderAt('/spieler/1');
    const card = await notesCard();
    expect(card.getByText('Früher als Al1ce unterwegs')).toBeInTheDocument();
    expect(card.getByText(/^mod,/)).toBeInTheDocument();
    expect(card.getByText(/bearbeitet/)).toBeInTheDocument();
    // Only the editable note offers edit/delete.
    expect(card.getAllByRole('button', { name: 'Bearbeiten' })).toHaveLength(1);
    await userEvent.click(card.getByText('Verlauf (1)'));
    expect(await card.findByText('Alte Fassung')).toBeInTheDocument();
  });

  it('adds a note and reloads the list', async () => {
    const fetchMock = mockApi({
      '/api/users/1/notes': (_url: URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? { status: 201, body: { ...sampleNotes[1], id: 9, body: 'Neu' } }
          : { body: { notes: sampleNotes } },
    });
    renderAt('/spieler/1');
    const card = await notesCard();
    await userEvent.type(card.getByLabelText('Neue Notiz'), 'Neu');
    await userEvent.click(card.getByRole('button', { name: 'Notiz speichern' }));
    await waitFor(() => {
      expect(calls(fetchMock, 'GET', '/api/users/1/notes')).toHaveLength(2);
    });
    expect(sentBody(calls(fetchMock, 'POST', '/api/users/1/notes')[0])).toEqual({ body: 'Neu' });
    expect(card.getByLabelText('Neue Notiz')).toHaveValue('');
  });

  it('edits and deletes an own note', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = mockApi({
      '/api/notes/7': (_url: URL, init?: RequestInit) =>
        init?.method === 'DELETE' ? { status: 204, body: null } : { body: sampleNotes[0] },
    });
    renderAt('/spieler/1');
    const card = await notesCard();
    await userEvent.click(card.getByRole('button', { name: 'Bearbeiten' }));
    const field = card.getByLabelText('Bearbeiten');
    await userEvent.clear(field);
    await userEvent.type(field, 'Geändert');
    await userEvent.click(card.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => {
      expect(calls(fetchMock, 'PATCH', '/api/notes/7')).toHaveLength(1);
    });
    expect(sentBody(calls(fetchMock, 'PATCH', '/api/notes/7')[0])).toEqual({ body: 'Geändert' });
    await userEvent.click(await card.findByRole('button', { name: 'Löschen' }));
    await waitFor(() => {
      expect(calls(fetchMock, 'DELETE', '/api/notes/7')).toHaveLength(1);
    });
  });

  it('shows server errors when saving fails', async () => {
    mockApi({
      '/api/users/1/notes': (_url: URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? { status: 403, body: { error: { code: 'FORBIDDEN', message: 'no' } } }
          : { body: { notes: sampleNotes } },
    });
    renderAt('/spieler/1');
    const card = await notesCard();
    await userEvent.type(card.getByLabelText('Neue Notiz'), 'x');
    await userEvent.click(card.getByRole('button', { name: 'Notiz speichern' }));
    expect(await card.findByRole('alert')).toHaveTextContent('Dafür fehlen dir die Rechte.');
  });

  it('is read-only for viewers', async () => {
    mockApi({
      ...asViewer,
      '/api/users/1/notes': { notes: sampleNotes.map((n) => ({ ...n, editable: false })) },
    });
    renderAt('/spieler/1');
    const card = await notesCard();
    expect(card.queryByLabelText('Neue Notiz')).not.toBeInTheDocument();
    expect(card.queryByRole('button', { name: 'Bearbeiten' })).not.toBeInTheDocument();
  });
});

describe('player tags', () => {
  it('shows the tags of the player', async () => {
    mockApi(asViewer);
    renderAt('/spieler/1');
    const list = await screen.findByRole('list', { name: 'Tags' });
    expect(within(list).getByText('Stammspieler')).toHaveClass('tag--green');
    expect(screen.queryByRole('button', { name: 'Tags bearbeiten' })).not.toBeInTheDocument();
  });

  it('lets moderators create and assign tags', async () => {
    const fetchMock = mockApi({
      '/api/auth/me': { user: { id: 3, username: 'mod', role: 'moderator' } },
      '/api/tags': (_url: URL, init?: RequestInit) =>
        init?.method === 'POST'
          ? { status: 201, body: { id: 5, name: 'Gast', color: 'orange' } }
          : {
              body: {
                tags: [
                  { id: 1, name: 'Stammspieler', color: 'green', users: 4 },
                  { id: 2, name: 'Clan', color: 'blue', users: 0 },
                ],
              },
            },
      '/api/users/1/tags': {
        tags: [
          { id: 2, name: 'Clan', color: 'blue' },
          { id: 5, name: 'Gast', color: 'orange' },
        ],
      },
    });
    renderAt('/spieler/1');
    await userEvent.click(await screen.findByRole('button', { name: 'Tags bearbeiten' }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Stammspieler/ }));
    await userEvent.click(screen.getByRole('checkbox', { name: /Clan/ }));
    // Moderators cannot delete tags.
    expect(screen.queryByRole('button', { name: /löschen/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Neuer Tag'), 'Gast');
    await userEvent.selectOptions(screen.getByLabelText('Farbe'), 'orange');
    await userEvent.click(screen.getByRole('button', { name: 'Anlegen' }));
    expect(await screen.findByRole('checkbox', { name: /Gast/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    const list = await screen.findByRole('list', { name: 'Tags' });
    await waitFor(() => {
      expect(within(list).getByText('Gast')).toBeInTheDocument();
    });
    expect(sentBody(calls(fetchMock, 'PUT', '/api/users/1/tags')[0])).toEqual({ tagIds: [2, 5] });
    expect(sentBody(calls(fetchMock, 'POST', '/api/tags')[0])).toEqual({
      name: 'Gast',
      color: 'orange',
    });
  });

  it('lets admins delete tags after confirmation', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fetchMock = mockApi({ '/api/tags/2': () => ({ status: 204, body: null }) });
    renderAt('/spieler/1');
    await userEvent.click(await screen.findByRole('button', { name: 'Tags bearbeiten' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Tag „Clan“ löschen' }));
    expect(confirm).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.queryByRole('checkbox', { name: /Clan/ })).not.toBeInTheDocument();
    });
    expect(calls(fetchMock, 'DELETE', '/api/tags/2')).toHaveLength(1);
  });
});
