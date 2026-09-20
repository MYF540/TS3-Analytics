/**
 * Drizzle schema. Source of the typed query API and of drizzle-kit migrations.
 *
 * Features drizzle-kit cannot express (STRICT, WITHOUT ROWID, FTS5 + triggers) are added by hand
 * to the generated migration SQL; `schema.test.ts` checks that both stay in sync.
 * Conventions: timestamps are UTC Unix seconds, durations are seconds, `day` is YYYYMMDD in
 * Europe/Berlin. The TS3 UID only lives in `users`; everything else references `users.id`.
 */
import { sql } from 'drizzle-orm';
import {
  blob,
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const SESSION_SOURCES = ['live', 'import'] as const;
export type SessionSource = (typeof SESSION_SOURCES)[number];

export const ACTIVITY_STATES = ['active', 'idle', 'afk', 'unknown'] as const;
export type ActivityState = (typeof ACTIVITY_STATES)[number];

export const users = sqliteTable(
  'users',
  {
    id: integer('id').primaryKey(),
    uid: text('uid').notNull(),
    dbid: integer('dbid'),
    firstSeen: integer('first_seen').notNull(),
    lastSeen: integer('last_seen').notNull(),
    platform: text('platform'),
    version: text('version'),
    /** ISO 3166-1 alpha-2 code of the most recent connection. */
    country: text('country'),
    /** Server group ids as JSON array, as last seen online (rank preview, excluded groups). */
    serverGroups: text('server_groups'),
    /** Set when the player's personal data was removed (GDPR, T7.2); playtime stays anonymous. */
    anonymizedAt: integer('anonymized_at'),
    /** Ranking time taken over from the old ranking system, seconds (T8.9). */
    legacySeconds: integer('legacy_seconds').notNull().default(0),
    /** Server group id the old ranking system had given this player, for the first rank run. */
    legacyRank: integer('legacy_rank'),
  },
  (t) => [
    uniqueIndex('users_uid_unique').on(t.uid),
    index('users_dbid_idx').on(t.dbid),
    index('users_last_seen_idx').on(t.lastSeen),
  ],
);

export const nicknames = sqliteTable(
  'nicknames',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nick: text('nick').notNull(),
    firstSeen: integer('first_seen').notNull(),
    lastSeen: integer('last_seen').notNull(),
  },
  (t) => [uniqueIndex('nicknames_user_nick_unique').on(t.userId, t.nick)],
);

export const channels = sqliteTable('channels', {
  /** TS3 channel id (cid). */
  id: integer('id').primaryKey(),
  name: text('name').notNull(),
  lastSeen: integer('last_seen').notNull(),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    joinAt: integer('join_at').notNull(),
    /** `null` while the session is open. */
    leaveAt: integer('leave_at'),
    duration: integer('duration'),
    source: text('source', { enum: SESSION_SOURCES }).notNull().default('live'),
  },
  (t) => [
    index('sessions_user_join_idx').on(t.userId, t.joinAt),
    index('sessions_join_idx').on(t.joinAt),
    index('sessions_leave_idx').on(t.leaveAt),
    index('sessions_open_idx')
      .on(t.userId)
      .where(sql`${t.leaveAt} IS NULL`),
    check('sessions_source_check', sql`${t.source} IN ('live', 'import')`),
    check('sessions_leave_check', sql`${t.leaveAt} IS NULL OR ${t.leaveAt} >= ${t.joinAt}`),
    check('sessions_duration_check', sql`${t.duration} IS NULL OR ${t.duration} >= 0`),
  ],
);

export const activitySegments = sqliteTable(
  'activity_segments',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sessionId: integer('session_id').references(() => sessions.id, { onDelete: 'cascade' }),
    startAt: integer('start_at').notNull(),
    /** Last time the segment was extended; final end once `isOpen` is false. */
    endAt: integer('end_at').notNull(),
    channelId: integer('channel_id').references(() => channels.id, { onDelete: 'set null' }),
    state: text('state', { enum: ACTIVITY_STATES }).notNull(),
    isOpen: integer('is_open', { mode: 'boolean' }).notNull().default(true),
  },
  (t) => [
    index('activity_segments_user_start_idx').on(t.userId, t.startAt),
    index('activity_segments_start_idx').on(t.startAt),
    index('activity_segments_session_idx').on(t.sessionId),
    index('activity_segments_open_idx')
      .on(t.userId)
      .where(sql`${t.isOpen} = 1`),
    check('activity_segments_state_check', sql`${t.state} IN ('active', 'idle', 'afk', 'unknown')`),
    check('activity_segments_range_check', sql`${t.endAt} >= ${t.startAt}`),
    check('activity_segments_open_check', sql`${t.isOpen} IN (0, 1)`),
  ],
);

export const userDailyStats = sqliteTable(
  'user_daily_stats',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Calendar day in Europe/Berlin as YYYYMMDD, e.g. 20260919. */
    day: integer('day').notNull(),
    onlineS: integer('online_s').notNull().default(0),
    activeS: integer('active_s').notNull().default(0),
    idleS: integer('idle_s').notNull().default(0),
    afkS: integer('afk_s').notNull().default(0),
    unknownS: integer('unknown_s').notNull().default(0),
    sessions: integer('sessions').notNull().default(0),
    longestSessionS: integer('longest_session_s').notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] }), index('user_daily_stats_day_idx').on(t.day)],
);

export const userTotals = sqliteTable(
  'user_totals',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    onlineS: integer('online_s').notNull().default(0),
    activeS: integer('active_s').notNull().default(0),
    sessions: integer('sessions').notNull().default(0),
    longestSessionS: integer('longest_session_s').notNull().default(0),
    firstSeen: integer('first_seen').notNull(),
    lastSeen: integer('last_seen').notNull(),
  },
  (t) => [
    index('user_totals_online_idx').on(t.onlineS),
    index('user_totals_active_idx').on(t.activeS),
    index('user_totals_longest_session_idx').on(t.longestSessionS),
  ],
);

export const serverMinutely = sqliteTable('server_minutely', {
  /** Start of the minute (UTC Unix seconds). */
  ts: integer('ts').primaryKey(),
  online: integer('online').notNull(),
});

export const serverHourly = sqliteTable('server_hourly', {
  /** Start of the hour (UTC Unix seconds). */
  hour: integer('hour').primaryKey(),
  /** Sum of online seconds of all sessions in this hour; average online = online_s / 3600. */
  onlineS: integer('online_s').notNull(),
  /** Maximum number of concurrent sessions within the hour. */
  maxOnline: integer('max_online').notNull(),
  uniqueUsers: integer('unique_users').notNull(),
});

export const ipSeen = sqliteTable(
  'ip_seen',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** HMAC-SHA256 of the full IP (32 bytes). The plain IP is never stored. */
    ipHash: blob('ip_hash', { mode: 'buffer' }).notNull(),
    /** HMAC-SHA256 of the /24 (IPv4) or /64 (IPv6) subnet. */
    subnetHash: blob('subnet_hash', { mode: 'buffer' }).notNull(),
    country: text('country'),
    firstSeen: integer('first_seen').notNull(),
    lastSeen: integer('last_seen').notNull(),
    seenCount: integer('seen_count').notNull().default(1),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.ipHash] }),
    index('ip_seen_ip_hash_idx').on(t.ipHash),
    index('ip_seen_subnet_hash_idx').on(t.subnetHash),
    index('ip_seen_last_seen_idx').on(t.lastSeen),
  ],
);

export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  /** JSON-encoded value. */
  value: text('value').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const ADMIN_ROLES = ['viewer', 'moderator', 'admin'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Accounts of the web interface (not TS3 users). Usernames are stored lower-case. */
export const adminUsers = sqliteTable(
  'admin_users',
  {
    id: integer('id').primaryKey(),
    username: text('username').notNull(),
    /** argon2id hash; the plain password is never stored. */
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ADMIN_ROLES }).notNull(),
    disabled: integer('disabled', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    lastLoginAt: integer('last_login_at'),
  },
  (t) => [
    uniqueIndex('admin_users_username_unique').on(t.username),
    check('admin_users_role_check', sql`${t.role} IN ('viewer', 'moderator', 'admin')`),
    check('admin_users_disabled_check', sql`${t.disabled} IN (0, 1)`),
  ],
);

/** Login sessions. Only a SHA-256 hash of the session token is stored. */
export const adminSessions = sqliteTable(
  'admin_sessions',
  {
    tokenHash: blob('token_hash', { mode: 'buffer' }).primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => adminUsers.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    lastSeenAt: integer('last_seen_at').notNull(),
  },
  (t) => [
    index('admin_sessions_user_idx').on(t.userId),
    index('admin_sessions_expires_idx').on(t.expiresAt),
  ],
);

/**
 * Audit trail of every state-changing action (web interface and CLI). The actor's name is kept as
 * a snapshot so entries stay readable after an account is deleted. Never contains passwords.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: integer('id').primaryKey(),
    at: integer('at').notNull(),
    actorId: integer('actor_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    /** Username at the time of the action, or `cli` / `anonymous`. */
    actorName: text('actor_name').notNull(),
    /** Dotted action code, e.g. `auth.login` or `POST /api/...` as fallback. */
    action: text('action').notNull(),
    targetType: text('target_type'),
    targetId: text('target_id'),
    /** JSON object with action-specific details. */
    details: text('details'),
    /** HTTP status of the request (null for CLI actions). */
    status: integer('status'),
  },
  (t) => [
    index('audit_log_at_idx').on(t.at),
    index('audit_log_actor_idx').on(t.actorName, t.at),
    index('audit_log_action_idx').on(t.action, t.at),
  ],
);

/** Moderator notes about a player. Deleting is soft, so the history stays available. */
export const playerNotes = sqliteTable(
  'player_notes',
  {
    id: integer('id').primaryKey(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    authorId: integer('author_id').references(() => adminUsers.id, { onDelete: 'set null' }),
    authorName: text('author_name').notNull(),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
  },
  (t) => [index('player_notes_user_idx').on(t.userId, t.createdAt)],
);

/** Previous versions of a note (one row per edit or deletion). */
export const playerNoteRevisions = sqliteTable(
  'player_note_revisions',
  {
    id: integer('id').primaryKey(),
    noteId: integer('note_id')
      .notNull()
      .references(() => playerNotes.id, { onDelete: 'cascade' }),
    body: text('body').notNull(),
    /** Who replaced or deleted this version, and when. */
    editorName: text('editor_name').notNull(),
    replacedAt: integer('replaced_at').notNull(),
  },
  (t) => [index('player_note_revisions_note_idx').on(t.noteId, t.replacedAt)],
);

export const TAG_COLORS = ['blue', 'orange', 'green', 'red', 'purple', 'gray'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const tags = sqliteTable(
  'tags',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    color: text('color', { enum: TAG_COLORS }).notNull().default('gray'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('tags_name_unique').on(sql`lower(${t.name})`),
    check(
      'tags_color_check',
      sql`${t.color} IN ('blue', 'orange', 'green', 'red', 'purple', 'gray')`,
    ),
  ],
);

export const userTags = sqliteTable(
  'user_tags',
  {
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    addedBy: text('added_by').notNull(),
    addedAt: integer('added_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.tagId] }), index('user_tags_tag_idx').on(t.tagId)],
);

/**
 * Mirror of the server's ban list (T5.1). Bans that disappear from the server keep their row with
 * `removed_at` set. IP bans only keep HMAC hashes (AGENTS.md rule 1); regex IP patterns are only
 * flagged, their text is not stored. Hashes of removed bans are cleared by the retention job.
 */
export const bans = sqliteTable(
  'bans',
  {
    /** TS3 ban id (`banid`). */
    id: integer('id').primaryKey(),
    uid: text('uid'),
    /** Resolved from `uid` when the user is known. */
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    ipHash: blob('ip_hash', { mode: 'buffer' }),
    subnetHash: blob('subnet_hash', { mode: 'buffer' }),
    /** The ban has an IP rule that is a pattern (regex), not a single address. */
    ipPattern: integer('ip_pattern', { mode: 'boolean' }).notNull().default(false),
    /** Nickname regex of a name ban. */
    namePattern: text('name_pattern'),
    lastNickname: text('last_nickname'),
    reason: text('reason'),
    invokerName: text('invoker_name'),
    invokerUid: text('invoker_uid'),
    createdAt: integer('created_at').notNull(),
    /** 0 = permanent. */
    durationS: integer('duration_s').notNull(),
    enforcements: integer('enforcements').notNull().default(0),
    firstSynced: integer('first_synced').notNull(),
    lastSynced: integer('last_synced').notNull(),
    removedAt: integer('removed_at'),
  },
  (t) => [
    index('bans_uid_idx').on(t.uid),
    index('bans_user_idx').on(t.userId),
    index('bans_ip_hash_idx').on(t.ipHash),
    index('bans_subnet_hash_idx').on(t.subnetHash),
  ],
);

export const FLAG_STATUSES = ['open', 'linked', 'ignored'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

/**
 * Alt/evasion hints (T5.2). One row per pair (`pair_key`); a new detection only refreshes
 * `evidence` and `last_detected`, so decisions (linked, ignored) stay. Evidence holds counts,
 * never hashes.
 */
export const flags = sqliteTable(
  'flags',
  {
    id: integer('id').primaryKey(),
    pairKey: text('pair_key').notNull(),
    kind: text('kind', { enum: ['ban_ip', 'ban_subnet', 'shared_ip'] }).notNull(),
    level: text('level', { enum: ['high', 'medium', 'info'] }).notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    relatedUserId: integer('related_user_id').references(() => users.id, { onDelete: 'cascade' }),
    banId: integer('ban_id').references(() => bans.id, { onDelete: 'set null' }),
    status: text('status', { enum: FLAG_STATUSES }).notNull().default('open'),
    /** JSON: `{ sharedIps, sharedSubnets, lastSeen }`. */
    evidence: text('evidence').notNull(),
    firstDetected: integer('first_detected').notNull(),
    lastDetected: integer('last_detected').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: integer('decided_at'),
  },
  (t) => [
    uniqueIndex('flags_pair_key_idx').on(t.pairKey),
    index('flags_status_level_idx').on(t.status, t.level, t.lastDetected),
    index('flags_user_idx').on(t.userId),
    index('flags_related_user_idx').on(t.relatedUserId),
  ],
);

/**
 * Several UIDs of one person (T5.3). Statistics and leaderboards group by the person's primary
 * user; `person_members` holds every member including the primary one.
 */
export const persons = sqliteTable('persons', {
  id: integer('id').primaryKey(),
  primaryUserId: integer('primary_user_id')
    .notNull()
    .references(() => users.id, { onDelete: 'restrict' }),
  createdAt: integer('created_at').notNull(),
  createdBy: text('created_by').notNull(),
});

export const personMembers = sqliteTable(
  'person_members',
  {
    userId: integer('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    personId: integer('person_id')
      .notNull()
      .references(() => persons.id, { onDelete: 'cascade' }),
    addedAt: integer('added_at').notNull(),
    addedBy: text('added_by').notNull(),
  },
  (t) => [index('person_members_person_idx').on(t.personId)],
);

/**
 * Server-group changes read from the server log (T5.7). Only parsed fields are stored, never the
 * log line. `user_id` is resolved from the client database id when the bot knows the client.
 */
export const groupChanges = sqliteTable(
  'group_changes',
  {
    id: integer('id').primaryKey(),
    /** UTC seconds of the log entry. */
    at: integer('at').notNull(),
    /** Log position (`at` * 1e6 + microseconds); unique per entry, used against duplicates. */
    logPos: integer('log_pos').notNull(),
    action: text('action', { enum: ['added', 'removed'] }).notNull(),
    dbid: integer('dbid').notNull(),
    userId: integer('user_id').references(() => users.id, { onDelete: 'set null' }),
    nickname: text('nickname'),
    groupId: integer('group_id').notNull(),
    groupName: text('group_name').notNull(),
    invokerName: text('invoker_name').notNull(),
    invokerDbid: integer('invoker_dbid').notNull(),
    /** The group was marked as protected when the change was seen. */
    protected: integer('protected', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [
    uniqueIndex('group_changes_entry_idx').on(t.logPos, t.dbid, t.groupId, t.action),
    index('group_changes_at_idx').on(t.at),
    index('group_changes_user_idx').on(t.userId),
  ],
);

/** Rank ladder (T6.1). Only server groups listed here are ever touched by the rank job. */
export const ranks = sqliteTable(
  'ranks',
  {
    id: integer('id').primaryKey(),
    name: text('name').notNull(),
    /** Ascending: 1 = lowest rank. */
    sortOrder: integer('sort_order').notNull(),
    /** Ranking time needed for this rank, in seconds. */
    requiredS: integer('required_s').notNull(),
    serverGroupId: integer('server_group_id').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('ranks_server_group_idx').on(t.serverGroupId),
    uniqueIndex('ranks_sort_order_idx').on(t.sortOrder),
  ],
);

/** Manual rank decisions per user (T6.5); for linked accounts they apply to the whole person. */
export const rankOverrides = sqliteTable('rank_overrides', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  /** Keep this rank regardless of time. */
  frozenRankId: integer('frozen_rank_id').references(() => ranks.id, { onDelete: 'set null' }),
  /** Added to the ranking time (may be negative). */
  bonusS: integer('bonus_s').notNull().default(0),
  /** Never rank this user (no rank group is set or removed). */
  excluded: integer('excluded', { mode: 'boolean' }).notNull().default(false),
  note: text('note'),
  updatedAt: integer('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});

/**
 * What the rank job decided per user: the target rank and whether the server groups were set.
 * Offline users keep `pending = 1` until their next join (decision 19.09.2026).
 */
export const rankState = sqliteTable('rank_state', {
  userId: integer('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  rankId: integer('rank_id').references(() => ranks.id, { onDelete: 'set null' }),
  pending: integer('pending', { mode: 'boolean' }).notNull().default(false),
  decidedAt: integer('decided_at').notNull(),
  appliedAt: integer('applied_at'),
});

/** Every rank change (and every would-be change in dry-run mode). */
export const rankHistory = sqliteTable(
  'rank_history',
  {
    id: integer('id').primaryKey(),
    at: integer('at').notNull(),
    userId: integer('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    fromRankId: integer('from_rank_id').references(() => ranks.id, { onDelete: 'set null' }),
    toRankId: integer('to_rank_id').references(() => ranks.id, { onDelete: 'set null' }),
    /** Ranking time at the decision, seconds. */
    rankingS: integer('ranking_s').notNull(),
    dryRun: integer('dry_run', { mode: 'boolean' }).notNull(),
    /** `applied`, `pending` (offline), `dry_run` or `failed`. */
    outcome: text('outcome', { enum: ['applied', 'pending', 'dry_run', 'failed'] }).notNull(),
  },
  (t) => [index('rank_history_user_idx').on(t.userId, t.at), index('rank_history_at_idx').on(t.at)],
);

export const IMPORT_SOURCES = ['logs', 'ranking'] as const;
export type ImportSource = (typeof IMPORT_SOURCES)[number];

export const IMPORT_STATUSES = ['running', 'done', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/**
 * One row per imported file (T8.2). Holds the byte offset so an interrupted run continues where
 * it stopped, and the counters the dry-run report is made of. `size` guards against a file that
 * changed after it was read.
 */
export const importRuns = sqliteTable(
  'import_runs',
  {
    id: integer('id').primaryKey(),
    source: text('source', { enum: IMPORT_SOURCES }).notNull(),
    /** File name as given to the CLI; unique per source. */
    file: text('file').notNull(),
    /** Size in bytes when the file was last read. */
    size: integer('size').notNull(),
    /** Bytes already processed; the point a resumed run starts at. */
    offset: integer('offset').notNull().default(0),
    status: text('status', { enum: IMPORT_STATUSES }).notNull(),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    linesRead: integer('lines_read').notNull().default(0),
    linesSkipped: integer('lines_skipped').notNull().default(0),
    sessionsWritten: integer('sessions_written').notNull().default(0),
    /** Lines that did not parse, sessions that were dropped – details go to the report. */
    problems: integer('problems').notNull().default(0),
    /** Last error of a failed run. */
    error: text('error'),
  },
  (t) => [
    uniqueIndex('import_runs_file_unique').on(t.source, t.file),
    check('import_runs_source_check', sql`${t.source} IN ('logs', 'ranking')`),
    check('import_runs_status_check', sql`${t.status} IN ('running', 'done', 'failed')`),
    check('import_runs_offset_check', sql`${t.offset} >= 0 AND ${t.offset} <= ${t.size}`),
  ],
);
