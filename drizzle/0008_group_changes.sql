-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `group_changes` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`log_pos` integer NOT NULL,
	`action` text NOT NULL,
	`dbid` integer NOT NULL,
	`user_id` integer,
	`nickname` text,
	`group_id` integer NOT NULL,
	`group_name` text NOT NULL,
	`invoker_name` text NOT NULL,
	`invoker_dbid` integer NOT NULL,
	`protected` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `group_changes_entry_idx` ON `group_changes` (`log_pos`,`dbid`,`group_id`,`action`);--> statement-breakpoint
CREATE INDEX `group_changes_at_idx` ON `group_changes` (`at`);--> statement-breakpoint
CREATE INDEX `group_changes_user_idx` ON `group_changes` (`user_id`);