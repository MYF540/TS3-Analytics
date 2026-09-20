-- Hand-edited: STRICT added (see docs/database.md).
CREATE TABLE `import_runs` (
	`id` integer PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`file` text NOT NULL,
	`size` integer NOT NULL,
	`offset` integer DEFAULT 0 NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`lines_read` integer DEFAULT 0 NOT NULL,
	`lines_skipped` integer DEFAULT 0 NOT NULL,
	`sessions_written` integer DEFAULT 0 NOT NULL,
	`problems` integer DEFAULT 0 NOT NULL,
	`error` text,
	CONSTRAINT "import_runs_source_check" CHECK("import_runs"."source" IN ('logs', 'ranking')),
	CONSTRAINT "import_runs_status_check" CHECK("import_runs"."status" IN ('running', 'done', 'failed')),
	CONSTRAINT "import_runs_offset_check" CHECK("import_runs"."offset" >= 0 AND "import_runs"."offset" <= "import_runs"."size")
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `import_runs_file_unique` ON `import_runs` (`source`,`file`);--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_seconds` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `legacy_rank` integer;