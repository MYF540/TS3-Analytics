-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `rule_acceptances` (
	`user_id` integer PRIMARY KEY NOT NULL,
	`version` integer NOT NULL,
	`decision` text NOT NULL,
	`at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "rule_acceptances_decision_check" CHECK("rule_acceptances"."decision" IN ('accepted', 'declined')),
	CONSTRAINT "rule_acceptances_version_check" CHECK("rule_acceptances"."version" >= 1)
) STRICT;
--> statement-breakpoint
CREATE INDEX `rule_acceptances_version_idx` ON `rule_acceptances` (`version`,`decision`);