CREATE INDEX `sessions_leave_idx` ON `sessions` (`leave_at`);--> statement-breakpoint
-- Hand-written: server_hourly only holds derived data (restore with `pnpm stats:rebuild`),
-- so it is recreated instead of altered. avg_online (REAL) becomes online_s (INTEGER seconds).
DROP TABLE `server_hourly`;--> statement-breakpoint
CREATE TABLE `server_hourly` (
	`hour` integer PRIMARY KEY NOT NULL,
	`online_s` integer NOT NULL,
	`max_online` integer NOT NULL,
	`unique_users` integer NOT NULL
) STRICT;
