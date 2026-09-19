-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `person_members` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`person_id` integer NOT NULL,
	`added_at` integer NOT NULL,
	`added_by` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `persons`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `person_members_person_idx` ON `person_members` (`person_id`);--> statement-breakpoint
CREATE TABLE `persons` (
	`id` integer PRIMARY KEY NOT NULL,
	`primary_user_id` integer NOT NULL,
	`created_at` integer NOT NULL,
	`created_by` text NOT NULL,
	FOREIGN KEY (`primary_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
) STRICT;
