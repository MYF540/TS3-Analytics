-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `bans` (
	`id` integer PRIMARY KEY NOT NULL,
	`uid` text,
	`user_id` integer,
	`ip_hash` blob,
	`subnet_hash` blob,
	`ip_pattern` integer DEFAULT false NOT NULL,
	`name_pattern` text,
	`last_nickname` text,
	`reason` text,
	`invoker_name` text,
	`invoker_uid` text,
	`created_at` integer NOT NULL,
	`duration_s` integer NOT NULL,
	`enforcements` integer DEFAULT 0 NOT NULL,
	`first_synced` integer NOT NULL,
	`last_synced` integer NOT NULL,
	`removed_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE INDEX `bans_uid_idx` ON `bans` (`uid`);--> statement-breakpoint
CREATE INDEX `bans_user_idx` ON `bans` (`user_id`);--> statement-breakpoint
CREATE INDEX `bans_ip_hash_idx` ON `bans` (`ip_hash`);--> statement-breakpoint
CREATE INDEX `bans_subnet_hash_idx` ON `bans` (`subnet_hash`);