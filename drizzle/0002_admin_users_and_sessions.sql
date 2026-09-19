-- Hand-edited: STRICT / WITHOUT ROWID added (see docs/database.md).
CREATE TABLE `admin_sessions` (
	`token_hash` blob PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `admin_sessions_user_idx` ON `admin_sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `admin_sessions_expires_idx` ON `admin_sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `admin_users` (
	`id` integer PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`role` text NOT NULL,
	`disabled` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`last_login_at` integer,
	CONSTRAINT "admin_users_role_check" CHECK("admin_users"."role" IN ('viewer', 'moderator', 'admin')),
	CONSTRAINT "admin_users_disabled_check" CHECK("admin_users"."disabled" IN (0, 1))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `admin_users_username_unique` ON `admin_users` (`username`);