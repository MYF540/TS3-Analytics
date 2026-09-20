import type { RouteObject } from 'react-router';
import { AuthProvider, RequireAuth, RequireRole } from './auth/AuthProvider';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { AuditPage } from './pages/AuditPage';
import { ChannelsPage } from './pages/ChannelsPage';
import { DashboardPage } from './pages/DashboardPage';
import { FlagsPage } from './pages/FlagsPage';
import { ImportPage } from './pages/ImportPage';
import { NetworkPage } from './pages/NetworkPage';
import { LeaderboardsPage } from './pages/LeaderboardsPage';
import { ErrorPage, NotFoundPage } from './pages/pages';
import { PlayerPage } from './pages/PlayerPage';
import { PlayersPage } from './pages/PlayersPage';
import { RanksPage } from './pages/RanksPage';
import { SettingsPage } from './pages/SettingsPage';
import { StatusPage } from './pages/StatusPage';

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
              { path: 'channels', element: <ChannelsPage /> },
              {
                element: <RequireRole role="moderator" />,
                children: [{ path: 'hinweise', element: <FlagsPage /> }],
              },
              {
                element: <RequireRole role="admin" />,
                children: [
                  { path: 'protokoll', element: <AuditPage /> },
                  { path: 'raenge', element: <RanksPage /> },
                  { path: 'abgleich', element: <ImportPage /> },
                  { path: 'netzwerk', element: <NetworkPage /> },
                  { path: 'status', element: <StatusPage /> },
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
