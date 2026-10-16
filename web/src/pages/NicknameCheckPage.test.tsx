import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { NicknameSettings } from '../api/types';
import { mockApi, renderAt } from '../test-utils';

const stored: NicknameSettings = {
  settings: {
    enabled: false,
    dryRun: true,
    exemptGroupIds: [6],
    patterns: [{ pattern: 'admin', regex: false }],
    lookalikes: true,
    action: 'kick',
    message: 'Dieser Nickname ist hier nicht erlaubt.',
    english: { enabled: false, message: 'This nickname is not allowed here.' },
  },
  groups: [
    { id: 6, name: 'Server Admin' },
    { id: 8, name: 'Guest' },
  ],
};

type Mock = ReturnType<typeof mockApi>;

/** Body of the last request with this method to the nickname endpoints. */
function sent(fetchMock: Mock, method: string, path = '/automation/nickname'): unknown {
  const call = fetchMock.mock.calls.findLast(
    ([input, init]) => (input as string).endsWith(path) && init?.method === method,
  );
  return call ? JSON.parse(call[1]?.body as string) : undefined;
}

function setup(overrides: Record<string, unknown> = {}): Mock {
  const fetchMock = mockApi({
    '/api/automation/nickname': (_url: URL, init?: RequestInit) => ({
      body:
        init?.method === 'PUT'
          ? { ...stored, settings: JSON.parse(init.body as string) as unknown }
          : stored,
    }),
    ...overrides,
  });
  renderAt('/automatik/nickname');
  return fetchMock;
}

describe('NicknameCheckPage', () => {
  it('shows the stored settings', async () => {
    setup();
    expect(await screen.findByLabelText('Muster 1')).toHaveValue('admin');
    expect(screen.getByLabelText('Modul einschalten')).not.toBeChecked();
    expect(screen.getByLabelText(/^Testmodus/)).toBeChecked();
    expect(screen.getByLabelText('Server Admin')).toBeChecked();
    expect(screen.getByLabelText('Guest')).not.toBeChecked();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  it('saves a new pattern with its own text', async () => {
    const fetchMock = setup();
    await screen.findByLabelText('Muster 1');
    await userEvent.click(screen.getByRole('button', { name: 'Muster hinzufügen' }));
    await userEvent.type(screen.getByLabelText('Muster 2'), '^mod');
    await userEvent.click(screen.getAllByLabelText('Regulärer Ausdruck')[1] as HTMLElement);
    await userEvent.type(
      screen.getAllByLabelText('Eigener Hinweistext (optional)')[1] as HTMLElement,
      'Kein Mod.',
    );
    await userEvent.click(screen.getByLabelText('Modul einschalten'));
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));

    await screen.findByText('Gespeichert.');
    expect(sent(fetchMock, 'PUT')).toEqual({
      ...stored.settings,
      enabled: true,
      patterns: [
        { pattern: 'admin', regex: false },
        { pattern: '^mod', regex: true, message: 'Kein Mod.' },
      ],
    });
  });

  it('warns before the module goes live', async () => {
    setup();
    await screen.findByLabelText('Muster 1');
    await userEvent.click(screen.getByLabelText('Modul einschalten'));
    expect(screen.queryByText(/greift nach dem Speichern wirklich/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByLabelText(/^Testmodus/));
    expect(screen.getByText(/greift nach dem Speichern wirklich/)).toBeInTheDocument();
  });

  it('does not save a broken regular expression', async () => {
    setup();
    await userEvent.click(await screen.findByLabelText('Regulärer Ausdruck'));
    await userEvent.clear(screen.getByLabelText('Muster 1'));
    await userEvent.type(screen.getByLabelText('Muster 1'), '[[a-');
    expect(screen.getByText('Dieser reguläre Ausdruck ist ungültig.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled();
  });

  it('removes a pattern and an exempt group', async () => {
    const fetchMock = setup();
    await userEvent.click(await screen.findByRole('button', { name: 'Muster 1 entfernen' }));
    await userEvent.click(screen.getByLabelText('Server Admin'));
    expect(screen.getByText(/ohne Muster tut das Modul nichts/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await screen.findByText('Gespeichert.');
    expect(sent(fetchMock, 'PUT')).toMatchObject({ patterns: [], exemptGroupIds: [] });
  });

  it('tries a nickname against the patterns of the form', async () => {
    const fetchMock = setup({ '/api/automation/nickname/test': { match: 0 } });
    await screen.findByLabelText('Muster 1');
    await userEvent.type(screen.getByLabelText('Nickname'), '4dm1n');
    await userEvent.click(screen.getByRole('button', { name: 'Prüfen' }));
    expect(
      await screen.findByText('Dieser Nickname ist verboten – Muster „admin“ trifft.'),
    ).toBeInTheDocument();
    expect(sent(fetchMock, 'POST', '/automation/nickname/test')).toEqual({
      nickname: '4dm1n',
      patterns: [{ pattern: 'admin', regex: false }],
      lookalikes: true,
    });
  });

  it('shows what the server says when it rejects the patterns', async () => {
    setup({
      '/api/automation/nickname': (_url: URL, init?: RequestInit) =>
        init?.method === 'PUT'
          ? { status: 400, body: { error: { code: 'INVALID_PATTERN', message: 'x' } } }
          : { body: stored },
    });
    await userEvent.click(await screen.findByLabelText('Modul einschalten'));
    await userEvent.click(screen.getByRole('button', { name: 'Speichern' }));
    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/lässt sich nicht verwenden/);
    });
  });

  it('is linked from the overview', async () => {
    mockApi({
      '/api/automation': {
        modules: [{ id: 'nickname', enabled: false, dryRun: true }],
        retentionDays: 90,
      },
      '/api/automation/log': { items: [], total: 0, page: 1, pageSize: 50 },
    });
    renderAt('/automatik');
    expect(
      await screen.findByRole('link', { name: 'Nickname-Checker einrichten' }),
    ).toHaveAttribute('href', '/automatik/nickname');
  });
});
