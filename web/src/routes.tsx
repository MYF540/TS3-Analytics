import type { RouteObject } from 'react-router';
import { AuthProvider, RequireAuth, RequireRole } from './auth/AuthProvider';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { AuditPage } from './pages/AuditPage';
import { DashboardPage } from './pages/DashboardPage';
import { LeaderboardsPage } from './pages/LeaderboardsPage';
import { ErrorPage, NotFoundPage } from './pages/pages';
import { PlayerPage } from './pages/PlayerPage';
import { PlayersPage } from './pages/PlayersPage';
import { SettingsPage } from './pages/SettingsPage';

/** URL paths are German, like the UI. Everything except the login page requires a login. */
export const routes: RouteObject[] = [
  {
    element: <AuthProvider />,
    errorElement: <ErrorPage />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            path: '/',
            element: <Layout />,
            errorElement: <ErrorPage />,
            children: [
              { index: true, element: <DashboardPage /> },
              { path: 'spieler', element: <PlayersPage /> },
              { path: 'spieler/:id', element: <PlayerPage /> },
              { path: 'leaderboards', element: <LeaderboardsPage /> },
              {
                element: <RequireRole role="admin" />,
                children: [
                  { path: 'protokoll', element: <AuditPage /> },
                  { path: 'einstellungen', element: <SettingsPage /> },
                ],
              },
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];
