CREATE TABLE `addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`line1` text NOT NULL,
	`line2` text,
	`city` text NOT NULL,
	`region` text NOT NULL,
	`postal_code` text NOT NULL,
	`country` text DEFAULT 'US' NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `addresses_user` ON `addresses` (`user_id`,`deleted_at`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text,
	`item_id` text,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`data` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_sale_created` ON `audit_log` (`sale_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_log_item` ON `audit_log` (`item_id`);--> statement-breakpoint
CREATE TABLE `blocks` (
	`seller_id` text NOT NULL,
	`blocked_user_id` text NOT NULL,
	`reason` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`seller_id`, `blocked_user_id`),
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`blocked_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `entries` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`user_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`note` text,
	`status` text NOT NULL,
	`rank_override` integer,
	`counter_cents` integer,
	`counter_expires_at` integer,
	`won_at` integer,
	`ended_at` integer,
	`ended_reason` text,
	`ended_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `entries_item_status` ON `entries` (`item_id`,`status`,`amount_cents`,`created_at`);--> statement-breakpoint
CREATE INDEX `entries_user_status` ON `entries` (`user_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `entries_one_pending` ON `entries` (`item_id`,`user_id`) WHERE "entries"."status" IN ('open', 'countered');--> statement-breakpoint
CREATE TABLE `fees` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text,
	`seller_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `fees_seller` ON `fees` (`seller_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `fees_invoice` ON `fees` (`invoice_id`);--> statement-breakpoint
CREATE TABLE `follows` (
	`follower_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`follower_id`, `seller_id`),
	FOREIGN KEY (`follower_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `follows_seller` ON `follows` (`seller_id`);--> statement-breakpoint
CREATE TABLE `invoice_lines` (
	`id` text PRIMARY KEY NOT NULL,
	`invoice_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`description` text NOT NULL,
	`amount_cents` integer NOT NULL,
	`refund_owed` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`invoice_id`) REFERENCES `invoices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoice_lines_invoice` ON `invoice_lines` (`invoice_id`);--> statement-breakpoint
CREATE INDEX `invoice_lines_entry` ON `invoice_lines` (`entry_id`);--> statement-breakpoint
CREATE TABLE `invoices` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`invoice_number` integer,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`subtotal_cents` integer DEFAULT 0 NOT NULL,
	`shipping_cents` integer DEFAULT 0 NOT NULL,
	`adjustment_cents` integer DEFAULT 0 NOT NULL,
	`total_cents` integer DEFAULT 0 NOT NULL,
	`gmv_cents` integer,
	`shipping_option_id` text,
	`shipping_address` text,
	`payment_ref` text,
	`carrier` text,
	`tracking_number` text,
	`sent_at` integer,
	`due_at` integer,
	`buyer_paid_at` integer,
	`paid_at` integer,
	`shipped_at` integer,
	`completed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invoices_sale_buyer_status` ON `invoices` (`sale_id`,`buyer_id`,`status`);--> statement-breakpoint
CREATE INDEX `invoices_buyer` ON `invoices` (`buyer_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `invoices_seller_number` ON `invoices` (`seller_id`,`invoice_number`) WHERE "invoices"."invoice_number" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `item_attributes` (
	`item_id` text NOT NULL,
	`key` text NOT NULL,
	`value_text` text,
	`value_num` integer,
	PRIMARY KEY(`item_id`, `key`),
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `item_attributes_text` ON `item_attributes` (`key`,`value_text`);--> statement-breakpoint
CREATE INDEX `item_attributes_num` ON `item_attributes` (`key`,`value_num`);--> statement-breakpoint
CREATE TABLE `item_images` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`item_id` text,
	`seller_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`match_image_id` text,
	`match_distance` integer,
	`verified_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `item_images_r2_key_unique` ON `item_images` (`r2_key`);--> statement-breakpoint
CREATE INDEX `item_images_item_sort` ON `item_images` (`item_id`,`sort_order`);--> statement-breakpoint
CREATE INDEX `item_images_sale` ON `item_images` (`sale_id`);--> statement-breakpoint
CREATE INDEX `item_images_seller_status` ON `item_images` (`seller_id`,`status`);--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`sort_order` integer NOT NULL,
	`game_id` text NOT NULL,
	`kind` text DEFAULT 'single' NOT NULL,
	`catalog_product_id` text,
	`title` text NOT NULL,
	`description_md` text DEFAULT '' NOT NULL,
	`condition` text,
	`finish` text,
	`language` text,
	`attributes` text DEFAULT '{}' NOT NULL,
	`grader` text,
	`grade` text,
	`cert_number` text,
	`sku` text,
	`price_cents` integer NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`per_buyer_limit` integer DEFAULT 1 NOT NULL,
	`offers_mode` text DEFAULT 'off' NOT NULL,
	`min_offer_cents` integer,
	`shipping_override_cents` integer,
	`state` text DEFAULT 'available' NOT NULL,
	`withdrawn_at` integer,
	`decision_deadline` integer,
	`offers_lapse_at` integer,
	`units_won` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `items_sale_sort` ON `items` (`sale_id`,`sort_order`);--> statement-breakpoint
CREATE UNIQUE INDEX `items_sale_sku` ON `items` (`sale_id`,`sku`) WHERE "items"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `items_catalog_product` ON `items` (`catalog_product_id`);--> statement-breakpoint
CREATE INDEX `items_game` ON `items` (`game_id`,`kind`);--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`type` text NOT NULL,
	`payload` text,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `notifications_user_created` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`limits` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rescinds` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`explanation` text NOT NULL,
	`attachment_key` text,
	`fault` text NOT NULL,
	`refund_owed` integer DEFAULT false NOT NULL,
	`refunded_at` integer,
	`refund_ref` text,
	`contested_at` integer,
	`contest_text` text,
	`resolved_by` text,
	`resolved_fault` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `rescinds_buyer` ON `rescinds` (`buyer_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rescinds_seller` ON `rescinds` (`seller_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `rescinds_entry` ON `rescinds` (`entry_id`);--> statement-breakpoint
CREATE TABLE `sale_access` (
	`sale_id` text PRIMARY KEY NOT NULL,
	`password_hash` text,
	`allowlist_enabled` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sale_allowlist` (
	`sale_id` text NOT NULL,
	`email` text NOT NULL,
	`invited_at` integer,
	`accepted_user_id` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`sale_id`, `email`),
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`accepted_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sales` (
	`id` text PRIMARY KEY NOT NULL,
	`seller_id` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description_md` text DEFAULT '' NOT NULL,
	`cover_image_id` text,
	`timestamp_image_id` text,
	`visibility` text DEFAULT 'unlisted' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`live_at` integer,
	`closes_at` integer,
	`published_at` integer,
	`rules` text DEFAULT '{}' NOT NULL,
	`shipping` text,
	`terms` text DEFAULT '{}' NOT NULL,
	`terms_md` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sales_slug_unique` ON `sales` (`slug`);--> statement-breakpoint
CREATE INDEX `sales_seller_status` ON `sales` (`seller_id`,`status`);--> statement-breakpoint
CREATE INDEX `sales_browse` ON `sales` (`status`,`visibility`,`live_at`);--> statement-breakpoint
CREATE TABLE `seller_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`payment_handles` text,
	`default_terms` text,
	`default_shipping` text,
	`default_market_pct` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`user_id` text NOT NULL,
	`plan_id` text NOT NULL,
	`stripe_customer_id` text,
	`status` text NOT NULL,
	`current_period_end` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`user_id`, `plan_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `takeback_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`reason` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`decided_at` integer,
	FOREIGN KEY (`entry_id`) REFERENCES `entries`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `takeback_requests_entry` ON `takeback_requests` (`entry_id`,`status`);--> statement-breakpoint
-- Plan catalogue seed (PLAN §3a). Hand-added: drizzle-kit doesn't generate data. Idempotent.
INSERT OR IGNORE INTO `plans` (`id`, `name`, `limits`) VALUES ('free', 'Free', '{}'), ('seller_pro', 'Seller Pro', '{"seller":"pro"}'), ('buyer_pro', 'Buyer Pro', '{"buyer":"pro"}'), ('bundle', 'Pro bundle', '{"seller":"pro","buyer":"pro"}');
