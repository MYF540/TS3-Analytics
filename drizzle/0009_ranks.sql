-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `rank_history` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`user_id` integer NOT NULL,
	`from_rank_id` integer,
	`to_rank_id` integer,
	`ranking_s` integer NOT NULL,
	`dry_run` integer NOT NULL,
	`outcome` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_rank_id`) REFERENCES `ranks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`to_rank_id`) REFERENCES `ranks`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE INDEX `rank_history_user_idx` ON `rank_history` (`user_id`,`at`);--> statement-breakpoint
CREATE INDEX `rank_history_at_idx` ON `rank_history` (`at`);--> statement-breakpoint
CREATE TABLE `rank_overrides` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`frozen_rank_id` integer,
	`bonus_s` integer DEFAULT 0 NOT NULL,
	`excluded` integer DEFAULT false NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL,
	`updated_by` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`frozen_rank_id`) REFERENCES `ranks`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE TABLE `rank_state` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`rank_id` integer,
	`pending` integer DEFAULT false NOT NULL,
	`decided_at` integer NOT NULL,
	`applied_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`rank_id`) REFERENCES `ranks`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE TABLE `ranks` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer NOT NULL,
	`required_s` integer NOT NULL,
	`server_group_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `ranks_server_group_idx` ON `ranks` (`server_group_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `ranks_sort_order_idx` ON `ranks` (`sort_order`);