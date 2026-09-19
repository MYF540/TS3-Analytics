CREATE TABLE `activity_segments` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`session_id` integer,
	`start_at` integer NOT NULL,
	`end_at` integer NOT NULL,
	`channel_id` integer,
	`state` text NOT NULL,
	`is_open` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`channel_id`) REFERENCES `channels`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "activity_segments_state_check" CHECK("activity_segments"."state" IN ('active', 'idle', 'afk', 'unknown')),
	CONSTRAINT "activity_segments_range_check" CHECK("activity_segments"."end_at" >= "activity_segments"."start_at"),
	CONSTRAINT "activity_segments_open_check" CHECK("activity_segments"."is_open" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE INDEX `activity_segments_user_start_idx` ON `activity_segments` (`user_id`,`start_at`);--> statement-breakpoint
CREATE INDEX `activity_segments_start_idx` ON `activity_segments` (`start_at`);--> statement-breakpoint
CREATE INDEX `activity_segments_session_idx` ON `activity_segments` (`session_id`);--> statement-breakpoint
CREATE INDEX `activity_segments_open_idx` ON `activity_segments` (`user_id`) WHERE "activity_segments"."is_open" = 1;--> statement-breakpoint
CREATE TABLE `channels` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`last_seen` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `ip_seen` (
	`user_id` integer NOT NULL,
	`ip_hash` blob NOT NULL,
	`subnet_hash` blob NOT NULL,
	`country` text,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`seen_count` integer DEFAULT 1 NOT NULL,
	PRIMARY KEY(`user_id`, `ip_hash`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `ip_seen_ip_hash_idx` ON `ip_seen` (`ip_hash`);--> statement-breakpoint
CREATE INDEX `ip_seen_subnet_hash_idx` ON `ip_seen` (`subnet_hash`);--> statement-breakpoint
CREATE INDEX `ip_seen_last_seen_idx` ON `ip_seen` (`last_seen`);--> statement-breakpoint
CREATE TABLE `nicknames` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`nick` text NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `nicknames_user_nick_unique` ON `nicknames` (`user_id`,`nick`);--> statement-breakpoint
CREATE TABLE `server_hourly` (
	`hour` integer PRIMARY KEY NOT NULL,
	`avg_online` real NOT NULL,
	`max_online` integer NOT NULL,
	`unique_users` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `server_minutely` (
	`ts` integer PRIMARY KEY NOT NULL,
	`online` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`join_at` integer NOT NULL,
	`leave_at` integer,
	`duration` integer,
	`source` text DEFAULT 'live' NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_source_check" CHECK("sessions"."source" IN ('live', 'import')),
	CONSTRAINT "sessions_leave_check" CHECK("sessions"."leave_at" IS NULL OR "sessions"."leave_at" >= "sessions"."join_at"),
	CONSTRAINT "sessions_duration_check" CHECK("sessions"."duration" IS NULL OR "sessions"."duration" >= 0)
) STRICT;
--> statement-breakpoint
CREATE INDEX `sessions_user_join_idx` ON `sessions` (`user_id`,`join_at`);--> statement-breakpoint
CREATE INDEX `sessions_join_idx` ON `sessions` (`join_at`);--> statement-breakpoint
CREATE INDEX `sessions_open_idx` ON `sessions` (`user_id`) WHERE "sessions"."leave_at" IS NULL;--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE TABLE `user_daily_stats` (
	`user_id` integer NOT NULL,
	`day` integer NOT NULL,
	`online_s` integer DEFAULT 0 NOT NULL,
	`active_s` integer DEFAULT 0 NOT NULL,
	`idle_s` integer DEFAULT 0 NOT NULL,
	`afk_s` integer DEFAULT 0 NOT NULL,
	`unknown_s` integer DEFAULT 0 NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`longest_session_s` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`user_id`, `day`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `user_daily_stats_day_idx` ON `user_daily_stats` (`day`);--> statement-breakpoint
CREATE TABLE `user_totals` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`online_s` integer DEFAULT 0 NOT NULL,
	`active_s` integer DEFAULT 0 NOT NULL,
	`sessions` integer DEFAULT 0 NOT NULL,
	`longest_session_s` integer DEFAULT 0 NOT NULL,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `user_totals_online_idx` ON `user_totals` (`online_s`);--> statement-breakpoint
CREATE INDEX `user_totals_active_idx` ON `user_totals` (`active_s`);--> statement-breakpoint
CREATE INDEX `user_totals_longest_session_idx` ON `user_totals` (`longest_session_s`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` integer PRIMARY KEY NOT NULL,
	`uid` text NOT NULL,
	`dbid` integer,
	`first_seen` integer NOT NULL,
	`last_seen` integer NOT NULL,
	`platform` text,
	`version` text,
	`country` text
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `users_uid_unique` ON `users` (`uid`);--> statement-breakpoint
CREATE INDEX `users_dbid_idx` ON `users` (`dbid`);--> statement-breakpoint
CREATE INDEX `users_last_seen_idx` ON `users` (`last_seen`);--> statement-breakpoint
-- Hand-written (not expressible in drizzle-kit): trigram full-text index over nicknames.
CREATE VIRTUAL TABLE `nicknames_fts` USING fts5(nick, content='nicknames', content_rowid='id', tokenize='trigram');--> statement-breakpoint
CREATE TRIGGER `nicknames_fts_ai` AFTER INSERT ON `nicknames` BEGIN
	INSERT INTO nicknames_fts(rowid, nick) VALUES (new.id, new.nick);
END;--> statement-breakpoint
CREATE TRIGGER `nicknames_fts_ad` AFTER DELETE ON `nicknames` BEGIN
	INSERT INTO nicknames_fts(nicknames_fts, rowid, nick) VALUES ('delete', old.id, old.nick);
END;--> statement-breakpoint
CREATE TRIGGER `nicknames_fts_au` AFTER UPDATE OF `nick` ON `nicknames` BEGIN
	INSERT INTO nicknames_fts(nicknames_fts, rowid, nick) VALUES ('delete', old.id, old.nick);
	INSERT INTO nicknames_fts(rowid, nick) VALUES (new.id, new.nick);
END;
