-- Hand-edited: STRICT and WITHOUT ROWID added (see docs/database.md).
CREATE TABLE `achievements_earned` (
	`user_id` integer NOT NULL,
	`achievement_id` text NOT NULL,
	`tier` integer NOT NULL,
	`earned_at` integer NOT NULL,
	`backfilled` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`user_id`, `achievement_id`, `tier`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "achievements_earned_tier_check" CHECK("achievements_earned"."tier" >= 1),
	CONSTRAINT "achievements_earned_backfilled_check" CHECK("achievements_earned"."backfilled" IN (0, 1))
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `achievements_earned_achievement_idx` ON `achievements_earned` (`achievement_id`,`tier`);--> statement-breakpoint
CREATE INDEX `achievements_earned_at_idx` ON `achievements_earned` (`earned_at`);