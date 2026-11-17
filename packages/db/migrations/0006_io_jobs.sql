CREATE TABLE `io_job_rows` (
	`job_id` text NOT NULL,
	`row_number` integer NOT NULL,
	`outcome` text NOT NULL,
	`target_id` text,
	`field` text,
	`message` text,
	PRIMARY KEY(`job_id`, `row_number`),
	FOREIGN KEY (`job_id`) REFERENCES `io_jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `io_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`sale_id` text,
	`kind` text NOT NULL,
	`status` text NOT NULL,
	`format` text,
	`file_key` text,
	`result_key` text,
	`row_count` integer DEFAULT 0 NOT NULL,
	`created` integer DEFAULT 0 NOT NULL,
	`updated` integer DEFAULT 0 NOT NULL,
	`skipped` integer DEFAULT 0 NOT NULL,
	`errors` integer DEFAULT 0 NOT NULL,
	`removed` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`finished_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `io_jobs_seller_created` ON `io_jobs` (`seller_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `io_jobs_sale` ON `io_jobs` (`sale_id`);