-- Hand-edited: STRICT and WITHOUT ROWID added (see docs/database.md).
CREATE TABLE `proxy_checks` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`verdict` text NOT NULL,
	`checked_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "proxy_checks_verdict_check" CHECK("proxy_checks"."verdict" IN ('clean', 'proxy'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `proxy_checks_verdict_idx` ON `proxy_checks` (`verdict`,`checked_at`);--> statement-breakpoint
CREATE TABLE `proxy_ips` (
	`ip_hash` blob PRIMARY KEY NOT NULL,
	`kind` text,
	`user_id` integer,
	`flagged_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `proxy_ips_user_idx` ON `proxy_ips` (`user_id`);