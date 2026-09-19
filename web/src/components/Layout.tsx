import { NavLink, Outlet } from 'react-router';
import { t } from '../i18n';
import { useTheme } from '../theme/theme';
import { StatusIndicator } from './StatusIndicator';

const NAV = [
  { to: '/', label: t('nav.dashboard'), end: true },
  { to: '/spieler', label: t('nav.players'), end: false },
  { to: '/leaderboards', label: t('nav.leaderboards'), end: false },
] as const;

export function Layout() {
  const { theme, toggle } = useTheme();
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        {t('app.skipToContent')}
      </a>
      <header className="header">
        <span className="header__brand">{t('app.title')}</span>
        <nav className="header__nav" aria-label={t('nav.main')}>
          {NAV.map((item) => (
            <NavLink key={item.to} to={item.to} end={item.end} className="nav-link">
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="header__tools">
          <StatusIndicator />
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
