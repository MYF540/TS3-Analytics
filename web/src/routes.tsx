import type { RouteObject } from 'react-router';
import { Layout } from './components/Layout';
import { DashboardPage } from './pages/DashboardPage';
import { ErrorPage, LeaderboardsPage, NotFoundPage } from './pages/pages';
import { PlayerPage } from './pages/PlayerPage';
import { PlayersPage } from './pages/PlayersPage';

/** URL paths are German, like the UI. */
export const routes: RouteObject[] = [
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
];
