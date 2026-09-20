-- Hand-edited: STRICT and WITHOUT ROWID added (see docs/database.md).
CREATE TABLE `network_edges` (
	`range` text NOT NULL,
	`user_a` integer NOT NULL,
	`user_b` integer NOT NULL,
	`seconds` integer NOT NULL,
	`encounters` integer NOT NULL,
	PRIMARY KEY(`range`, `user_a`, `user_b`),
	FOREIGN KEY (`user_a`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_b`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "network_edges_range_check" CHECK("network_edges"."range" IN ('30d', '90d', '1y', 'all')),
	CONSTRAINT "network_edges_order_check" CHECK("network_edges"."user_a" < "network_edges"."user_b"),
	CONSTRAINT "network_edges_seconds_check" CHECK("network_edges"."seconds" > 0)
) STRICT, WITHOUT ROWID;
--> statement-breakpoint
CREATE INDEX `network_edges_seconds_idx` ON `network_edges` (`range`,`seconds`);--> statement-breakpoint
CREATE TABLE `network_nodes` (
	`range` text NOT NULL,
	`user_id` integer NOT NULL,
	`seconds` integer NOT NULL,
	PRIMARY KEY(`range`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "network_nodes_range_check" CHECK("network_nodes"."range" IN ('30d', '90d', '1y', 'all')),
	CONSTRAINT "network_nodes_seconds_check" CHECK("network_nodes"."seconds" >= 0)
) STRICT, WITHOUT ROWID;
