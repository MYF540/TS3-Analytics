import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { safeRedirect } from '../auth/context';
import { mockApi, renderAt, requested } from '../test-utils';

const anonymous = () => ({
  status: 401,
  body: { error: { code: 'UNAUTHORIZED', message: 'Login required' } },
});

describe('login', () => {
  it('sends anonymous visitors to the login page and back after logging in', async () => {
    let loggedIn = false;
    const fetchMock = mockApi({
      '/api/auth/me': () =>
        loggedIn ? { body: { user: { id: 1, username: 'alice', role: 'admin' } } } : anonymous(),
      '/api/auth/login': (_url: URL, init?: RequestInit) => {
        const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
          username: string;
          password: string;
        };
        if (body.password !== 'correct horse battery') {
          return {
            status: 401,
            body: { error: { code: 'INVALID_CREDENTIALS', message: 'Invalid' } },
          };
        }
        loggedIn = true;
        return { body: { user: { id: 1, username: 'alice', role: 'admin' } } };
      },
    });
    const router = renderAt('/spieler?q=bob');

    expect(await screen.findByRole('button', { name: 'Anmelden' })).toBeDisabled();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toBe(`?weiter=${encodeURIComponent('/spieler?q=bob')}`);

    await userEvent.type(screen.getByLabelText('Benutzername'), 'alice');
    await userEvent.type(screen.getByLabelText('Passwort'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Benutzername oder Passwort ist falsch.',
    );
    expect(screen.getByLabelText('Passwort')).toHaveValue('');

    await userEvent.type(screen.getByLabelText('Passwort'), 'correct horse battery');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/spieler');
    });
    expect(router.state.location.search).toBe('?q=bob');
    const login = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/auth/login'),
    );
    expect(login?.[1]).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(requested(fetchMock, '/api/auth/login')).toHaveLength(2);
  });

  it('explains a temporary lock with the remaining minutes', async () => {
    mockApi({
      '/api/auth/me': anonymous,
      '/api/auth/login': () => ({
        status: 429,
        body: { error: { code: 'RATE_LIMITED', message: 'x', details: { retryAfterS: 610 } } },
      }),
    });
    renderAt('/login');
    await userEvent.type(await screen.findByLabelText('Benutzername'), 'alice');
    await userEvent.type(screen.getByLabelText('Passwort'), 'whatever');
    await userEvent.click(screen.getByRole('button', { name: 'Anmelden' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Zu viele Fehlversuche. Bitte in 11 Minuten erneut versuchen.',
    );
  });

  it('shows the user and logs out', async () => {
    const fetchMock = mockApi();
    const router = renderAt('/');
    expect(await screen.findByText('admin')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Abmelden' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
    expect(requested(fetchMock, '/api/auth/logout')).toHaveLength(1);
  });

  it('returns to the login when the session expires', async () => {
    let expired = false;
    mockApi({
      '/api/stats/overview': () =>
        expired
          ? anonymous()
          : {
              body: {
                range: '24h',
                onlineNow: 1,
                peakToday: 1,
                peakInRange: 1,
                peakAllTime: 1,
                usersTotal: 1,
                usersNew: 0,
              },
            },
    });
    const router = renderAt('/');
    await screen.findByRole('heading', { name: 'Dashboard' });
    expired = true;
    await userEvent.click(screen.getByRole('radio', { name: '7 Tage' }));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe('/login');
    });
  });

  it('only redirects to paths inside the app', () => {
    expect(safeRedirect('/spieler/1')).toBe('/spieler/1');
    expect(safeRedirect('//evil.example')).toBe('/');
    expect(safeRedirect('/\\evil.example')).toBe('/');
    expect(safeRedirect('https://evil.example')).toBe('/');
    expect(safeRedirect(null)).toBe('/');
  });
});
