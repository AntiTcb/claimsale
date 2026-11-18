CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`reporter_id` text NOT NULL,
	`target_kind` text NOT NULL,
	`target_id` text NOT NULL,
	`reason` text NOT NULL,
	`details` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	`resolution_note` text,
	FOREIGN KEY (`reporter_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reports_one_open` ON `reports` (`reporter_id`,`target_kind`,`target_id`) WHERE "reports"."status" = 'open';--> statement-breakpoint
CREATE INDEX `reports_status_created` ON `reports` (`status`,`created_at`);--> statement-breakpoint
ALTER TABLE `rescinds` ADD `resolution_note` text;--> statement-breakpoint
ALTER TABLE `rescinds` ADD `phase` text;--> statement-breakpoint
ALTER TABLE `rescinds` ADD `answered_at` integer;--> statement-breakpoint
CREATE INDEX `rescinds_phase` ON `rescinds` (`phase`,`created_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `banned_at` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `banned_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `banned_by` text;--> statement-breakpoint
ALTER TABLE `users` ADD `decision_window_max_hours` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `decision_window_request_hours` integer;--> statement-breakpoint
ALTER TABLE `users` ADD `decision_window_request_reason` text;--> statement-breakpoint
ALTER TABLE `users` ADD `decision_window_requested_at` integer;