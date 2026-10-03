-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `automation_log` (
	`id` integer PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`module` text NOT NULL,
	`action` text NOT NULL,
	`user_id` integer,
	`detail` text,
	`result` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "automation_log_module_check" CHECK("automation_log"."module" IN ('nickname', 'support', 'staff', 'channels', 'private', 'rules', 'spam', 'proxy')),
	CONSTRAINT "automation_log_result_check" CHECK("automation_log"."result" IN ('done', 'dry', 'failed'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `automation_log_at_idx` ON `automation_log` (`at`);--> statement-breakpoint
CREATE INDEX `automation_log_module_idx` ON `automation_log` (`module`,`at`);--> statement-breakpoint
CREATE INDEX `automation_log_user_idx` ON `automation_log` (`user_id`);