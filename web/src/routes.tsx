import type { RouteObject } from 'react-router';
import { Layout } from './components/Layout';
import {
  DashboardPage,
  ErrorPage,
  LeaderboardsPage,
  NotFoundPage,
  PlayerPage,
  PlayersPage,
} from './pages/pages';

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
