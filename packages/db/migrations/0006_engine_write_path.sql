CREATE TABLE `import_rows` (
	`import_id` text NOT NULL,
	`row` integer NOT NULL,
	`sale_id` text NOT NULL,
	`item_id` text,
	`outcome` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`import_id`, `row`),
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `import_rows_sale` ON `import_rows` (`sale_id`);--> statement-breakpoint
CREATE INDEX `entries_counter_expiry` ON `entries` (`counter_expires_at`) WHERE "entries"."status" = 'countered';--> statement-breakpoint
CREATE INDEX `invoices_status_due` ON `invoices` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `invoices_status_shipped` ON `invoices` (`status`,`shipped_at`);--> statement-breakpoint
CREATE INDEX `items_decision_deadline` ON `items` (`decision_deadline`) WHERE "items"."decision_deadline" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `items_offers_lapse_at` ON `items` (`offers_lapse_at`) WHERE "items"."offers_lapse_at" IS NOT NULL;