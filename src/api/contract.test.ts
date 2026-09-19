/**
 * Keeps the frontend's API types (web/src/api/types.ts) and the backend's zod schemas in sync.
 * The checks run at type level during `pnpm typecheck`; the runtime test only makes Vitest happy.
 */
import { describe, expect, it } from 'vitest';
import type { z } from 'zod';
import type * as Web from '../../web/src/api/types.js';
import type { ApiErrorBody } from './errors.js';
import type { healthResponse } from './routes/health.js';
import type { leaderboardResponse } from './routes/leaderboards.js';
import type { onlineResponse } from './routes/online.js';
import type { heatmapResponse, overviewResponse, seriesResponse } from './routes/stats.js';
import type { userDetailResponse, userListItem } from './routes/users.js';

// Standard exact type equality check; the single-use type parameters are the point of the trick.
/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters */
type Equals<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */
type Assert<T extends true> = T;

export type Contract = [
  Assert<Equals<z.output<typeof healthResponse>, Web.Health>>,
  Assert<Equals<z.output<typeof overviewResponse>, Web.Overview>>,
  Assert<Equals<z.output<typeof seriesResponse>, Web.OnlineSeries>>,
  Assert<Equals<z.output<typeof heatmapResponse>, Web.Heatmap>>,
  Assert<Equals<z.output<typeof userListItem>, Web.UserListItem>>,
  Assert<Equals<z.output<typeof userDetailResponse>, Web.UserDetail>>,
  Assert<Equals<z.output<typeof leaderboardResponse>, Web.Leaderboard>>,
  Assert<Equals<z.output<typeof onlineResponse>, Web.OnlineNow>>,
  Assert<Equals<ApiErrorBody, Web.ApiErrorBody>>,
];

describe('API contract', () => {
  it('is checked by the type checker', () => {
    expect(true).toBe(true);
  });
});
