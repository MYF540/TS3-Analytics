import { errorMessage } from '../i18n';
import type {
  ApiErrorBody,
  AuthResponse,
  Health,
  Heatmap,
  Leaderboard,
  LeaderboardMetric,
  LeaderboardPeriod,
  OnlineNow,
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
    /** Seconds until a rate limit ends (RATE_LIMITED). */
    readonly retryAfterS?: number,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

/** Dispatched on `window` whenever the API answers 401 (session missing or expired). */
export const UNAUTHORIZED_EVENT = 'ts3a:unauthorized';

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

async function request<T>(
  method: 'GET' | 'POST',
  path: string,
  query?: Query,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(buildUrl(path, query), {
      method,
      headers:
        body === undefined
          ? { accept: 'application/json' }
          : { accept: 'application/json', 'content-type': 'application/json' },
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiRequestError(0, 'NETWORK', errorMessage('NETWORK'));
  }
  if (response.status === 204) return undefined as T;
  const payload: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code = isErrorBody(payload) ? payload.error.code : 'UNKNOWN';
    if (response.status === 401 && path !== '/auth/login') {
      window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
    }
    const details = isErrorBody(payload) ? payload.error.details : undefined;
    const retryAfterS =
      typeof details === 'object' && details !== null && 'retryAfterS' in details
        ? Number(details.retryAfterS)
        : undefined;
    throw new ApiRequestError(response.status, code, errorMessage(code), retryAfterS);
  }
  return payload as T;
}

export function apiGet<T>(path: string, query?: Query, signal?: AbortSignal): Promise<T> {
  return request<T>('GET', path, query, undefined, signal);
}

export function apiPost<T>(path: string, body: unknown = {}): Promise<T> {
  return request<T>('POST', path, undefined, body);
}

/** Typed endpoint functions. */
export const api = {
  health: (signal?: AbortSignal) => apiGet<Health>('/health', {}, signal),
  me: (signal?: AbortSignal) => apiGet<AuthResponse>('/auth/me', {}, signal),
  login: (username: string, password: string) =>
    apiPost<AuthResponse>('/auth/login', { username, password }),
  logout: () => apiPost<undefined>('/auth/logout'),
  onlineNow: (signal?: AbortSignal) => apiGet<OnlineNow>('/online', {}, signal),
  overview: (range: TimeRange, signal?: AbortSignal) =>
    apiGet<Overview>('/stats/overview', { range }, signal),
  online: (
    query: { range?: TimeRange | undefined; from?: number | undefined; to?: number | undefined },
    signal?: AbortSignal,
  ) => apiGet<OnlineSeries>('/stats/online', query, signal),
  heatmap: (range: TimeRange, signal?: AbortSignal) =>
    apiGet<Heatmap>('/stats/heatmap', { range }, signal),
  users: (
    query: {
      search?: string | undefined;
      sort?: UserSort | undefined;
      order?: 'asc' | 'desc' | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
      includeCasual?: boolean | undefined;
    },
    signal?: AbortSignal,
  ) => apiGet<Paged<UserListItem>>('/users', query, signal),
  user: (id: number, days?: number, signal?: AbortSignal) =>
    apiGet<UserDetail>(`/users/${String(id)}`, { days }, signal),
  leaderboard: (
    query: {
      period?: LeaderboardPeriod | undefined;
      metric?: LeaderboardMetric | undefined;
      from?: string | undefined;
      to?: string | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
    signal?: AbortSignal,
  ) => apiGet<Leaderboard>('/leaderboards', query, signal),
};
