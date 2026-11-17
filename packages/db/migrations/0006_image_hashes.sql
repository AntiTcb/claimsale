CREATE TABLE `account_flags` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reason` text NOT NULL,
	`count` integer NOT NULL,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	`resolved_by` text,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `account_flags_open` ON `account_flags` (`user_id`,`reason`) WHERE "account_flags"."resolved_at" IS NULL;--> statement-breakpoint
CREATE INDEX `account_flags_created` ON `account_flags` (`resolved_at`,`created_at`);--> statement-breakpoint
CREATE TABLE `image_hashes` (
	`image_id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`sale_id` text NOT NULL,
	`item_id` text,
	`dhash` text NOT NULL,
	`phash` text NOT NULL,
	`d0` integer NOT NULL,
	`d1` integer NOT NULL,
	`d2` integer NOT NULL,
	`d3` integer NOT NULL,
	`p0` integer NOT NULL,
	`p1` integer NOT NULL,
	`p2` integer NOT NULL,
	`p3` integer NOT NULL,
	`decision` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	`decided_at` integer NOT NULL,
	`decided_by` text NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `image_hashes_d0` ON `image_hashes` (`d0`);--> statement-breakpoint
CREATE INDEX `image_hashes_d1` ON `image_hashes` (`d1`);--> statement-breakpoint
CREATE INDEX `image_hashes_d2` ON `image_hashes` (`d2`);--> statement-breakpoint
CREATE INDEX `image_hashes_d3` ON `image_hashes` (`d3`);--> statement-breakpoint
CREATE INDEX `image_hashes_p0` ON `image_hashes` (`p0`);--> statement-breakpoint
CREATE INDEX `image_hashes_p1` ON `image_hashes` (`p1`);--> statement-breakpoint
CREATE INDEX `image_hashes_p2` ON `image_hashes` (`p2`);--> statement-breakpoint
CREATE INDEX `image_hashes_p3` ON `image_hashes` (`p3`);--> statement-breakpoint
CREATE INDEX `image_hashes_seller_decision` ON `image_hashes` (`seller_id`,`decision`);--> statement-breakpoint
ALTER TABLE `users` ADD `role` text DEFAULT 'user' NOT NULL;