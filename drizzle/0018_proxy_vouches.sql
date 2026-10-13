-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `proxy_vouches` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`sponsor_user_id` integer,
	`at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sponsor_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
) STRICT;
--> statement-breakpoint
CREATE INDEX `proxy_vouches_sponsor_idx` ON `proxy_vouches` (`sponsor_user_id`);