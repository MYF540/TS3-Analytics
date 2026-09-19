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
  tags: Tag[];
  /** Linked UIDs of the same person (T5.3); totals, daily and channels include all of them. */
  person: Person | null;
}

export interface Person {
  id: number;
  primaryUserId: number;
  members: {
    userId: number;
    uid: string;
    nickname: string | null;
    addedAt: number;
    addedBy: string;
  }[];
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

export type TagColor = 'blue' | 'orange' | 'green' | 'red' | 'purple' | 'gray';

export interface Tag {
  id: number;
  name: string;
  color: TagColor;
}

export interface TagWithUsage extends Tag {
  users: number;
}

export interface Note {
  id: number;
  userId: number;
  authorName: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  revisions: number;
  editable: boolean;
}

export interface NoteRevision {
  body: string;
  editorName: string;
  replacedAt: number;
}

export type FlagKind = 'ban_ip' | 'ban_subnet' | 'shared_ip';
export type FlagLevel = 'high' | 'medium' | 'info';
export type FlagStatus = 'open' | 'linked' | 'ignored';

export interface PlayerRef {
  id: number;
  nickname: string | null;
}

export interface FlagItem {
  id: number;
  kind: FlagKind;
  level: FlagLevel;
  status: FlagStatus;
  user: PlayerRef;
  related: PlayerRef | null;
  ban: { id: number; reason: string | null; active: boolean } | null;
  evidence: { sharedIps: number; sharedSubnets: number; lastSeen: number };
  firstDetected: number;
  lastDetected: number;
  current: boolean;
  decidedBy: string | null;
  decidedAt: number | null;
}

export interface FlagsResponse extends Paged<FlagItem> {
  openCounts: { high: number; medium: number; info: number };
  lastRun: number | null;
}

export interface TimedMessage {
  at: number;
  message: string;
}

export interface BotStatus {
  process: {
    version: string;
    nodeVersion: string;
    startedAt: number;
    uptimeS: number;
    rssBytes: number;
    heapUsedBytes: number;
  };
  ts3: {
    state: string;
    since: number;
    failedAttempts: number;
    lastConnectedAt: number | null;
    lastError: TimedMessage | null;
    queuedCommands: number;
  } | null;
  watcher: { lastHeartbeat: number | null; onlineClients: number | null; openSessions: number };
  database: {
    sizeBytes: number;
    walBytes: number | null;
    freeBytes: number;
    users: number;
    sessions: number;
    segments: number;
  };
  jobs: {
    name: string;
    intervalS: number;
    lastRun: number | null;
    nextRun: number;
    lastError: TimedMessage | null;
  }[];
  problems: {
    at: number;
    level: 'warn' | 'error' | 'fatal';
    message: string;
    detail: string | null;
    count: number;
  }[];
}

export interface ActivitySettings {
  idleThresholdS: number;
  afkChannelIds: number[];
  awayIsAfk: boolean;
  outputMutedIsAfk: boolean;
}

export interface ActivitySettingsResponse {
  settings: ActivitySettings;
  defaults: ActivitySettings;
  channels: { id: number; name: string; lastSeen: number }[];
}

export interface LeaderboardEntry {
  rank: number;
  userId: number;
  uid: string;
  nickname: string | null;
  value: number;
  accounts: number;
}

export interface Leaderboard extends Paged<LeaderboardEntry> {
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  fromDay: number | null;
  toDay: number | null;
}
