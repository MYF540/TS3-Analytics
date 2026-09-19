import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { mockApi, renderAt, requested } from '../test-utils';
import { auditActionLabel as actionLabel } from '../i18n';

const entries = {
  items: [
    {
      id: 2,
      at: 1_789_800_000,
      actorName: 'alice',
      action: 'auth.login',
      targetType: 'admin_user',
      targetId: '1',
      details: null,
      status: 200,
    },
    {
      id: 1,
      at: 1_789_799_000,
      actorName: 'anonymous',
      action: 'auth.login_failed',
      targetType: null,
      targetId: null,
      details: { username: 'mallory' },
      status: 401,
    },
  ],
  total: 2,
  page: 1,
  pageSize: 50,
};
const filters = { actors: ['alice', 'anonymous'], actions: ['auth.login', 'auth.login_failed'] };
const viewer = { user: { id: 2, username: 'vera', role: 'viewer' } };

describe('AuditPage', () => {
  it('lists entries with German action names and results', async () => {
    mockApi({ '/api/audit': entries, '/api/audit/filters': filters });
    renderAt('/protokoll');
    const cell = await screen.findByRole('cell', { name: 'Fehlgeschlagene Anmeldung' });
    const row = cell.closest('tr');
    if (!row) throw new Error('row missing');
    expect(within(row).getByText('username: mallory')).toBeInTheDocument();
    expect(within(row).getByText('abgelehnt (401)')).toBeInTheDocument();
    expect(screen.getAllByText('erfolgreich')).toHaveLength(1);
  });

  it('filters by person and action', async () => {
    const fetchMock = mockApi({ '/api/audit': entries, '/api/audit/filters': filters });
    renderAt('/protokoll');
    await screen.findByRole('cell', { name: 'Fehlgeschlagene Anmeldung' });
    await userEvent.selectOptions(screen.getByLabelText('Person'), 'alice');
    await userEvent.selectOptions(screen.getByLabelText('Aktion'), 'auth.login');
    await waitFor(() => {
      const last = requested(fetchMock, '/api/audit').at(-1)?.searchParams;
      expect(last?.get('actor')).toBe('alice');
      expect(last?.get('action')).toBe('auth.login');
    });
  });

  it('is only in the navigation for admins and refuses others', async () => {
    mockApi({ '/api/auth/me': viewer });
    renderAt('/protokoll');
    expect(await screen.findByRole('heading', { name: 'Keine Berechtigung' })).toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).queryByRole('link', { name: 'Protokoll' })).toBeNull();
  });

  it('shows the navigation entry to admins', async () => {
    mockApi({ '/api/audit': entries, '/api/audit/filters': filters });
    renderAt('/');
    const nav = await screen.findByRole('navigation', { name: 'Hauptnavigation' });
    expect(within(nav).getByRole('link', { name: 'Protokoll' })).toHaveAttribute(
      'href',
      '/protokoll',
    );
  });

  it('falls back to the raw code for unknown actions', () => {
    expect(actionLabel('auth.logout')).toBe('Abmeldung');
    expect(actionLabel('POST /api/something')).toBe('POST /api/something');
  });
});
