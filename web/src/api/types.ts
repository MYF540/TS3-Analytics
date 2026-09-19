/**
 * Response types of the backend API. Deliberately free of imports: the backend type-checks these
 * against its zod schemas (`src/api/contract.test.ts`), so both sides cannot drift apart.
 */

export type TimeRange = '24h' | '7d' | '30d' | '1y' | 'all';
export type LeaderboardPeriod = 'all' | 'week' | 'month' | 'year' | 'custom';
export type LeaderboardMetric = 'online' | 'active' | 'longestSession';
export type UserSort = 'online' | 'active' | 'sessions' | 'lastSeen' | 'firstSeen' | 'nickname';

export type AdminRole = 'viewer' | 'moderator' | 'admin';

export interface AuthUser {
  id: number;
  username: string;
  role: AdminRole;
}

export interface AuthResponse {
  user: AuthUser;
}

export interface AuditEntry {
  id: number;
  at: number;
  actorName: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
  status: number | null;
}

export interface AuditFilters {
  actors: string[];
  actions: string[];
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface Health {
  status: 'ok' | 'degraded' | 'down';
  uptimeS: number;
  db: { ok: boolean; latencyMs: number };
  ts3: { state: string; connected: boolean };
}

export interface Overview {
  range: TimeRange;
  onlineNow: number;
  peakToday: number;
  peakInRange: number;
  peakAllTime: number;
  usersTotal: number;
  usersNew: number;
}

export interface SeriesPoint {
  t: number;
  avgOnline: number;
  maxOnline: number;
}

export interface OnlineSeries {
  from: number;
  to: number;
  resolution: number;
  points: SeriesPoint[];
}

export interface Heatmap {
  range: TimeRange;
  values: number[][];
}

export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface UserListItem {
  userId: number;
  uid: string;
  nickname: string | null;
  onlineS: number;
  activeS: number;
  sessions: number;
  firstSeen: number;
  lastSeen: number;
  country: string | null;
  online: boolean;
}

export interface UserDetail {
  user: {
    id: number;
    uid: string;
    dbid: number | null;
    nickname: string | null;
    firstSeen: number;
    lastSeen: number;
    platform: string | null;
    version: string | null;
    country: string | null;
  };
  online: { since: number } | null;
  totals: { onlineS: number; activeS: number; sessions: number; longestSessionS: number };
  nicknames: { nick: string; firstSeen: number; lastSeen: number }[];
  recentSessions: {
    id: number;
    joinAt: number;
    leaveAt: number | null;
    duration: number | null;
    source: 'live' | 'import';
  }[];
  daily: {
    day: number;
    onlineS: number;
    activeS: number;
    idleS: number;
    afkS: number;
    unknownS: number;
    sessions: number;
  }[];
  topChannels: { channelId: number | null; name: string | null; seconds: number }[];
  countries: { country: string; lastSeen: number; connections: number }[];
}

export interface OnlineNow {
  connected: boolean;
  items: {
    userId: number;
    nickname: string;
    channelId: number;
    channelName: string | null;
    state: 'active' | 'idle' | 'afk' | null;
    since: number;
  }[];
}

export interface LeaderboardEntry {
  rank: number;
  userId: number;
  uid: string;
  nickname: string | null;
  value: number;
}

export interface Leaderboard extends Paged<LeaderboardEntry> {
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  fromDay: number | null;
  toDay: number | null;
}
