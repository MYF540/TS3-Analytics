-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `managed_channels` (
	`channel_id` integer PRIMARY KEY NOT NULL,
	`module` text NOT NULL,
	`scope` text NOT NULL,
	`owner_user_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "managed_channels_module_check" CHECK("managed_channels"."module" IN ('channels', 'private'))
) STRICT;
--> statement-breakpoint
CREATE INDEX `managed_channels_scope_idx` ON `managed_channels` (`module`,`scope`);--> statement-breakpoint
CREATE INDEX `managed_channels_owner_idx` ON `managed_channels` (`owner_user_id`);