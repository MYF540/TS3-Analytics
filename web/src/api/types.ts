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

/** Settings of the player network and the result of the last daily run (T9.1). */
export interface NetworkSettings {
  settings: {
    excludedChannelIds: number[];
    candidates: number;
    minEncounterS: number;
    minPairS: number;
  };
  defaults: NetworkSettings['settings'];
  channels: { id: number; name: string; lastSeen: number; afk: boolean }[];
  state: {
    computedAt: number;
    seconds: number;
    ranges: Record<
      string,
      { nodes: number; edges: number; droppedPairs: number; from: number; to: number }
    >;
  } | null;
}

/** Log time against the value of the old ranking system, per player (T8.10). */
export interface ImportComparison {
  items: {
    userId: number;
    nickname: string | null;
    placeholder: boolean;
    logS: number;
    legacyS: number;
    diffS: number;
  }[];
  total: number;
  matching: number;
  toleranceS: number;
}

/** Where the numbers of a period come from: imported logs or live tracking (T8.7). */
export interface DataSources {
  importedFrom: number | null;
  importedTo: number | null;
  liveSince: number | null;
}

/** Only short ranges: channel time comes from the raw segments (see routes/channels.ts). */
export type ChannelRange = '24h' | '7d' | '30d';

export interface ChannelUsage {
  range: ChannelRange;
  from: number;
  to: number;
  total: number;
  totalSeconds: number;
  items: {
    channelId: number | null;
    name: string | null;
    seconds: number;
    users: number;
    visits: number;
    lastUsed: number;
    present: boolean;
  }[];
}

export interface UnusedChannels {
  days: number;
  since: number;
  items: { channelId: number; name: string; lastSeen: number }[];
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

export interface Rank {
  id: number;
  name: string;
  sortOrder: number;
  requiredS: number;
  serverGroupId: number;
}

export interface PlayerRank {
  enabled: boolean;
  dryRun: boolean;
  rankingS: number;
  target: { id: number; name: string } | null;
  next: { id: number; name: string; remainingS: number } | null;
  pending: boolean;
  skipped: 'excluded' | 'excluded_group' | null;
  frozen: boolean;
  override: {
    frozenRankId: number | null;
    bonusS: number;
    excluded: boolean;
    note: string | null;
    updatedAt: number;
    updatedBy: string;
  } | null;
  ranks: { id: number; name: string }[];
}

export interface RankSettings {
  countMode: 'online' | 'active';
  excludedGroupIds: number[];
  dryRun: boolean;
  intervalMinutes: number;
  promotionMessage: { enabled: boolean; text: string };
}

export interface RankConfig {
  ranks: Rank[];
  settings: RankSettings;
  knownGroups: { id: number; name: string }[];
  lastRun: number | null;
}

export interface RankDraft {
  ranks: { id?: number; name: string; requiredS: number; serverGroupId: number }[];
  settings: RankSettings;
}

export interface RankPreview {
  dryRun: boolean;
  counts: { up: number; down: number; skipped: number };
  changes: {
    userId: number;
    nickname: string | null;
    accounts: number;
    rankingS: number;
    fromRankId: number | null;
    toRankId: number | null;
    fromRankName: string | null;
    toRankName: string | null;
    direction: 'up' | 'down';
    frozen: boolean;
  }[];
}

export interface RankHistoryItem {
  id: number;
  at: number;
  userId: number;
  nickname: string | null;
  fromRankId: number | null;
  toRankId: number | null;
  fromRankName: string | null;
  toRankName: string | null;
  rankingS: number;
  dryRun: boolean;
  outcome: 'applied' | 'pending' | 'dry_run' | 'failed';
}

export interface RankRunResult {
  skipped: 'not_connected' | 'no_ranks' | null;
  full: boolean;
  dryRun: boolean;
  checked: number;
  changed: number;
  commands: number;
  pending: number;
  failed: number;
}

export interface GroupSettings {
  protectedGroupIds: number[];
  knownGroups: { id: number; name: string }[];
}

export interface GroupChange {
  id: number;
  at: number;
  action: 'added' | 'removed';
  userId: number | null;
  nickname: string | null;
  groupId: number;
  groupName: string;
  invokerName: string;
  protected: boolean;
}

export interface BanTemplate {
  id: string;
  label: string;
  reason: string;
  /** 0 = permanent. */
  durationS: number;
}

export interface ModerationSettings {
  enabled: boolean;
  banTemplates: BanTemplate[];
}

export type ModerationAction =
  | { type: 'poke'; message: string }
  | { type: 'message'; message: string }
  | { type: 'kick'; from: 'server' | 'channel'; reason?: string | undefined }
  | { type: 'move'; channelId: number }
  | {
      type: 'ban';
      templateId?: string | undefined;
      reason?: string | undefined;
      durationS?: number | undefined;
      includeIp?: boolean | undefined;
    };

export type AlertEvent =
  | 'flag.high'
  | 'flag.medium'
  | 'ban.added'
  | 'bot.connection'
  | 'join.spike'
  | 'group.protected'
  | 'rank.promoted';

export interface AlertSettings {
  configured: boolean;
  webhookHint: string | null;
  events: AlertEvent[];
  ratePerMinute: number;
  joinSpike: { windowMinutes: number; threshold: number };
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
