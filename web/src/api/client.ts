import { errorMessage } from '../i18n';
import type {
  ActivitySettings,
  ActivitySettingsResponse,
  AlertEvent,
  AlertSettings,
  ApiErrorBody,
  AuditEntry,
  AuditFilters,
  AuthResponse,
  BotStatus,
  ChannelRange,
  ChannelUsage,
  FlagLevel,
  FlagsResponse,
  FlagStatus,
  GroupChange,
  GroupSettings,
  Health,
  Heatmap,
  Leaderboard,
  LeaderboardMetric,
  LeaderboardPeriod,
  ModerationAction,
  ModerationSettings,
  Note,
  NoteRevision,
  OnlineNow,
  OnlineSeries,
  RankConfig,
  RankDraft,
  RankHistoryItem,
  RankPreview,
  RankRunResult,
  Person,
  PlayerRank,
  Overview,
  Paged,
  Tag,
  TagColor,
  TagWithUsage,
  TimeRange,
  UnusedChannels,
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

/** Display text for any error thrown by an API call. */
export function describeError(error: unknown): string {
  return error instanceof ApiRequestError ? error.message : errorMessage('UNKNOWN');
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
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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

function apiSend<T>(method: 'PATCH' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  return request<T>(method, path, undefined, body);
}

/** Typed endpoint functions. */
export const api = {
  health: (signal?: AbortSignal) => apiGet<Health>('/health', {}, signal),
  me: (signal?: AbortSignal) => apiGet<AuthResponse>('/auth/me', {}, signal),
  login: (username: string, password: string) =>
    apiPost<AuthResponse>('/auth/login', { username, password }),
  logout: () => apiPost<undefined>('/auth/logout'),
  audit: (
    query: {
      actor?: string | undefined;
      action?: string | undefined;
      from?: string | undefined;
      to?: string | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
    signal?: AbortSignal,
  ) => apiGet<Paged<AuditEntry>>('/audit', query, signal),
  auditFilters: (signal?: AbortSignal) => apiGet<AuditFilters>('/audit/filters', {}, signal),
  onlineNow: (signal?: AbortSignal) => apiGet<OnlineNow>('/online', {}, signal),
  overview: (range: TimeRange, signal?: AbortSignal) =>
    apiGet<Overview>('/stats/overview', { range }, signal),
  online: (
    query: { range?: TimeRange | undefined; from?: number | undefined; to?: number | undefined },
    signal?: AbortSignal,
  ) => apiGet<OnlineSeries>('/stats/online', query, signal),
  heatmap: (range: TimeRange, signal?: AbortSignal) =>
    apiGet<Heatmap>('/stats/heatmap', { range }, signal),
  channelUsage: (range: ChannelRange, signal?: AbortSignal) =>
    apiGet<ChannelUsage>('/channels/usage', { range }, signal),
  unusedChannels: (days: number, signal?: AbortSignal) =>
    apiGet<UnusedChannels>('/channels/unused', { days }, signal),
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
  notes: (userId: number, signal?: AbortSignal) =>
    apiGet<{ notes: Note[] }>(`/users/${String(userId)}/notes`, {}, signal),
  addNote: (userId: number, body: string) =>
    apiPost<Note>(`/users/${String(userId)}/notes`, { body }),
  updateNote: (noteId: number, body: string) =>
    apiSend<Note>('PATCH', `/notes/${String(noteId)}`, { body }),
  deleteNote: (noteId: number) => apiSend<undefined>('DELETE', `/notes/${String(noteId)}`),
  noteRevisions: (noteId: number, signal?: AbortSignal) =>
    apiGet<{ revisions: NoteRevision[] }>(`/notes/${String(noteId)}/revisions`, {}, signal),
  status: (signal?: AbortSignal) => apiGet<BotStatus>('/status', {}, signal),
  flags: (
    query: {
      status?: FlagStatus | 'all' | undefined;
      level?: FlagLevel | 'all' | undefined;
      userId?: number | undefined;
      page?: number | undefined;
      pageSize?: number | undefined;
    },
    signal?: AbortSignal,
  ) => apiGet<FlagsResponse>('/flags', query, signal),
  setFlagStatus: (id: number, status: FlagStatus) =>
    apiPost<{ id: number; status: FlagStatus }>(`/flags/${String(id)}/status`, { status }),
  /** Link for the GDPR export download (T7.2). */
  exportUrl: (userId: number) => `/api/users/${String(userId)}/export`,
  anonymizeUser: (userId: number, confirmUid: string) =>
    apiPost<{ nicknames: number; ipSeen: number; notes: number; flags: number }>(
      `/users/${String(userId)}/anonymize`,
      { confirmUid },
    ),
  playerRank: (userId: number, signal?: AbortSignal) =>
    apiGet<PlayerRank>(`/users/${String(userId)}/rank`, {}, signal),
  setRankOverride: (
    userId: number,
    override: {
      frozenRankId: number | null;
      bonusHours: number;
      excluded: boolean;
      note: string | null;
    },
  ) => apiSend<PlayerRank>('PUT', `/users/${String(userId)}/rank-override`, override),
  ranks: (signal?: AbortSignal) => apiGet<RankConfig>('/ranks', {}, signal),
  saveRanks: (draft: RankDraft) => apiSend<RankConfig>('PUT', '/ranks', draft),
  previewRanks: (draft: RankDraft) => apiPost<RankPreview>('/ranks/preview', draft),
  runRanks: () => apiPost<RankRunResult>('/ranks/run'),
  rankHistory: (query: { page?: number; pageSize?: number }, signal?: AbortSignal) =>
    apiGet<Paged<RankHistoryItem>>('/ranks/history', query, signal),
  groupSettings: (signal?: AbortSignal) => apiGet<GroupSettings>('/settings/groups', {}, signal),
  saveGroupSettings: (protectedGroupIds: number[]) =>
    apiSend<GroupSettings>('PUT', '/settings/groups', { protectedGroupIds }),
  groupChanges: (
    query: { protectedOnly?: boolean; userId?: number; page?: number; pageSize?: number },
    signal?: AbortSignal,
  ) => apiGet<Paged<GroupChange>>('/group-changes', query, signal),
  moderationSettings: (signal?: AbortSignal) =>
    apiGet<ModerationSettings>('/settings/moderation', {}, signal),
  saveModerationSettings: (settings: ModerationSettings) =>
    apiSend<ModerationSettings>('PUT', '/settings/moderation', settings),
  moderate: (userId: number, action: ModerationAction) =>
    apiPost<{ affected: number }>(`/users/${String(userId)}/moderation`, action),
  alertSettings: (signal?: AbortSignal) => apiGet<AlertSettings>('/settings/alerts', {}, signal),
  saveAlertSettings: (settings: {
    webhookUrl?: string | null;
    events: AlertEvent[];
    ratePerMinute: number;
    joinSpike: { windowMinutes: number; threshold: number };
  }) => apiSend<AlertSettings>('PUT', '/settings/alerts', settings),
  testAlert: () => apiPost<{ ok: boolean; status: number | null }>('/settings/alerts/test'),
  activitySettings: (signal?: AbortSignal) =>
    apiGet<ActivitySettingsResponse>('/settings/activity', {}, signal),
  saveActivitySettings: (settings: ActivitySettings) =>
    apiSend<ActivitySettings>('PUT', '/settings/activity', settings),
  linkUser: (userId: number, otherUserId: number) =>
    apiPost<{ person: Person | null }>(`/users/${String(userId)}/links`, { userId: otherUserId }),
  unlinkUser: (userId: number) =>
    apiSend<{ person: Person | null }>('DELETE', `/users/${String(userId)}/links`),
  setPrimaryUser: (userId: number) =>
    apiPost<{ person: Person | null }>(`/users/${String(userId)}/primary`),
  tags: (signal?: AbortSignal) => apiGet<{ tags: TagWithUsage[] }>('/tags', {}, signal),
  createTag: (name: string, color: TagColor) => apiPost<Tag>('/tags', { name, color }),
  deleteTag: (tagId: number) => apiSend<undefined>('DELETE', `/tags/${String(tagId)}`),
  setUserTags: (userId: number, tagIds: number[]) =>
    apiSend<{ tags: Tag[] }>('PUT', `/users/${String(userId)}/tags`, { tagIds }),
};
