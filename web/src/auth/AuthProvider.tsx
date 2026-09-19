import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { api, UNAUTHORIZED_EVENT } from '../api/client';
import { t } from '../i18n';
import { AuthContext, hasRole, useAuth, type AuthState } from './context';

/** Route element that provides the login state to all pages below it. */
export function AuthProvider() {
  const [state, setState] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    api
      .me(controller.signal)
      .then(({ user }) => {
        setState({ status: 'authenticated', user });
      })
      .catch(() => {
        if (!controller.signal.aborted) setState({ status: 'anonymous' });
      });
    // Any 401 (expired or revoked session) sends the user back to the login.
    const onUnauthorized = () => {
      setState({ status: 'anonymous' });
    };
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    return () => {
      controller.abort();
      window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized);
    };
  }, []);

  const login = useCallback(async (username: string, password: string) => {
    const { user } = await api.login(username, password);
    setState({ status: 'authenticated', user });
  }, []);

  const logout = useCallback(async () => {
    await api.logout().catch(() => undefined);
    setState({ status: 'anonymous' });
  }, []);

  const value = useMemo(() => ({ state, login, logout }), [state, login, logout]);
  return (
    <AuthContext.Provider value={value}>
      <Outlet />
    </AuthContext.Provider>
  );
}

/** Renders its pages only for users with at least the given role. */
export function RequireRole({ role }: { role: 'moderator' | 'admin' }) {
  const { state } = useAuth();
  if (state.status !== 'authenticated') return null;
  if (!hasRole(state.user, role)) {
    return (
      <section>
        <h1>{t('page.forbidden.title')}</h1>
        <p className="muted">{t('page.forbidden.text')}</p>
      </section>
    );
  }
  return <Outlet />;
}

/** Only renders its pages for logged-in users; everyone else goes to the login page. */
export function RequireAuth() {
  const { state } = useAuth();
  const location = useLocation();
  if (state.status === 'loading') return <p className="muted center">{t('common.loading')}</p>;
  if (state.status === 'anonymous') {
    const target = `${location.pathname}${location.search}`;
    const next = target === '/' ? '' : `?weiter=${encodeURIComponent(target)}`;
    return <Navigate to={`/login${next}`} replace />;
  }
  return <Outlet />;
}
