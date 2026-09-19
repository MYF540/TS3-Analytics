import { errorMessage } from '../i18n';
import type {
  ApiErrorBody,
  Health,
  Heatmap,
  Leaderboard,
  LeaderboardMetric,
  LeaderboardPeriod,
  OnlineSeries,
  Overview,
  Paged,
  TimeRange,
  UserDetail,
  UserListItem,
  UserSort,
} from './types';

/** A failed API call; `message` is already translated for display. */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

type Query = Record<string, string | number | boolean | undefined>;

export function buildUrl(path: string, query: Query = {}): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  const search = params.toString();
  return `/api${path}${search ? `?${search}` : ''}`;
}

function isErrorBody(value: unknown): value is ApiErrorBody {
  return (
    typeof value === 'object' &&
    value !== null &&
    'error' in value &&
    typeof (value as ApiErrorBody).error.code === 'string'
  );
}

export async function apiGet<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      headers: { accept: 'application/json' },
      credentials: 'same-origin',
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, 'NETWORK', errorMessage('NETWORK'));
  }
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = isErrorBody(body) ? body.error.code : 'UNKNOWN';
    throw new ApiRequestError(response.status, code, errorMessage(code));
  }
  return body as T;
}

/** Typed endpoint functions. */
export const api = {
  health: (signal?: AbortSignal) => apiGet<Health>('/health', {}, signal),
  overview: (range: TimeRange, signal?: AbortSignal) =>
    apiGet<Overview>('/stats/overview', { range }, signal),
  online: (query: { range?: TimeRange; from?: number; to?: number }, signal?: AbortSignal) =>
    apiGet<OnlineSeries>('/stats/online', query, signal),
  heatmap: (range: TimeRange, signal?: AbortSignal) =>
    apiGet<Heatmap>('/stats/heatmap', { range }, signal),
  users: (
    query: {
      search?: string;
      sort?: UserSort;
      order?: 'asc' | 'desc';
      page?: number;
      pageSize?: number;
      includeCasual?: boolean;
    },
    signal?: AbortSignal,
  ) => apiGet<Paged<UserListItem>>('/users', query, signal),
  user: (id: number, days?: number, signal?: AbortSignal) =>
    apiGet<UserDetail>(`/users/${String(id)}`, { days }, signal),
  leaderboard: (
    query: {
      period?: LeaderboardPeriod;
      metric?: LeaderboardMetric;
      from?: string;
      to?: string;
      page?: number;
      pageSize?: number;
    },
    signal?: AbortSignal,
  ) => apiGet<Leaderboard>('/leaderboards', query, signal),
};
