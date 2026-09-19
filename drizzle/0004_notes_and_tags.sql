-- Hand-edited: STRICT / WITHOUT ROWID added (see docs/database.md).
CREATE TABLE `player_note_revisions` (
	`id` integer PRIMARY KEY NOT NULL,
	`note_id` integer NOT NULL,
	`body` text NOT NULL,
	`editor_name` text NOT NULL,
	`replaced_at` integer NOT NULL,
	FOREIGN KEY (`note_id`) REFERENCES `player_notes`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `player_note_revisions_note_idx` ON `player_note_revisions` (`note_id`,`replaced_at`);--> statement-breakpoint
CREATE TABLE `player_notes` (
	`id` integer PRIMARY KEY NOT NULL,
	`user_id` integer NOT NULL,
	`author_id` integer,
	`author_name` text NOT NULL,
	`body` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `admin_users`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE INDEX `player_notes_user_idx` ON `player_notes` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`color` text DEFAULT 'gray' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "tags_color_check" CHECK("tags"."color" IN ('blue', 'orange', 'green', 'red', 'purple', 'gray'))
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (lower("name"));--> statement-breakpoint
CREATE TABLE `user_tags` (
	`user_id` integer NOT NULL,
	`tag_id` integer NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `tag_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
) WITHOUT ROWID, STRICT;
--> statement-breakpoint
CREATE INDEX `user_tags_tag_idx` ON `user_tags` (`tag_id`);