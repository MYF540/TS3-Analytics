import type { RouteObject } from 'react-router';
import { AuthProvider, RequireAuth } from './auth/AuthProvider';
import { Layout } from './components/Layout';
import { LoginPage } from './pages/LoginPage';
import { DashboardPage } from './pages/DashboardPage';
import { LeaderboardsPage } from './pages/LeaderboardsPage';
import { ErrorPage, NotFoundPage } from './pages/pages';
import { PlayerPage } from './pages/PlayerPage';
import { PlayersPage } from './pages/PlayersPage';

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
              { path: '*', element: <NotFoundPage /> },
            ],
          },
        ],
      },
    ],
  },
];
