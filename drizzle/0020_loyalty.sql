-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `loyalty_cohorts` (
	`month` integer PRIMARY KEY NOT NULL,
	`size` integer NOT NULL,
	`eligible_7` integer NOT NULL,
	`returned_7` integer NOT NULL,
	`eligible_30` integer NOT NULL,
	`returned_30` integer NOT NULL,
	`eligible_90` integer NOT NULL,
	`returned_90` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `loyalty_months` (
	`month` integer PRIMARY KEY NOT NULL,
	`active` integer NOT NULL,
	`newcomers` integer NOT NULL,
	`returners` integer NOT NULL,
	`lost` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `loyalty_players` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`first_day` integer NOT NULL,
	`last_day` integer NOT NULL,
	`recent_s` integer NOT NULL,
	`total_s` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
) STRICT;
--> statement-breakpoint
CREATE INDEX `loyalty_players_last_day_idx` ON `loyalty_players` (`last_day`,`recent_s`);