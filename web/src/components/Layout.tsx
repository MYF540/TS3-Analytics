import { NavLink, Outlet } from 'react-router';
import { useAuth } from '../auth/context';
import { t } from '../i18n';
import { useTheme } from '../theme/theme';
import { StatusIndicator } from './StatusIndicator';

const NAV: { to: string; label: string; end: boolean; adminOnly?: boolean }[] = [
  { to: '/', label: t('nav.dashboard'), end: true },
  { to: '/spieler', label: t('nav.players'), end: false },
  { to: '/leaderboards', label: t('nav.leaderboards'), end: false },
  { to: '/protokoll', label: t('nav.audit'), end: false, adminOnly: true },
  { to: '/status', label: t('nav.status'), end: false, adminOnly: true },
  { to: '/einstellungen', label: t('nav.settings'), end: false, adminOnly: true },
];

export function Layout() {
  const { theme, toggle } = useTheme();
  const { state, logout } = useAuth();
  const user = state.status === 'authenticated' ? state.user : undefined;
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <header className="header">
        <span className="header__brand">{t('app.title')}</span>
        <nav className="header__nav" aria-label={t('nav.main')}>
          {NAV.filter((item) => !item.adminOnly || user?.role === 'admin').map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="header__tools">
          <StatusIndicator />
          {user && (
            <span
              className="header__user muted"
              title={t('auth.signedInAs', { name: user.username, role: t(`role.${user.role}`) })}
            >
              {user.username}
            </span>
          )}
          <button
            type="button"
            className="button button--small"
            onClick={() => {
              void logout();
            }}
          >
            {t('auth.logout')}
          </button>
          <button
            type="button"
            className="icon-button"
            onClick={toggle}
            aria-label={t('theme.toggle')}
            title={t(theme === 'dark' ? 'theme.light' : 'theme.dark')}
          >
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </header>
      <main id="main" className="main">
        <Outlet />
      </main>
    </div>
  );
}
