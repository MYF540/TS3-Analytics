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
