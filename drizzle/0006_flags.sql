-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `flags` (
	`id` integer PRIMARY KEY NOT NULL,
	`pair_key` text NOT NULL,
	`kind` text NOT NULL,
	`level` text NOT NULL,
	`user_id` integer NOT NULL,
	`related_user_id` integer,
	`ban_id` integer,
	`status` text DEFAULT 'open' NOT NULL,
	`evidence` text NOT NULL,
	`first_detected` integer NOT NULL,
	`last_detected` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`related_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ban_id`) REFERENCES `bans`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `flags_pair_key_idx` ON `flags` (`pair_key`);--> statement-breakpoint
CREATE INDEX `flags_status_level_idx` ON `flags` (`status`,`level`,`last_detected`);--> statement-breakpoint
CREATE INDEX `flags_user_idx` ON `flags` (`user_id`);--> statement-breakpoint
CREATE INDEX `flags_related_user_idx` ON `flags` (`related_user_id`);