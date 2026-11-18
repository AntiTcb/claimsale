CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`sale_id` text NOT NULL,
	`buyer_id` text NOT NULL,
	`seller_id` text NOT NULL,
	`last_message_at` integer,
	`buyer_read_at` integer,
	`seller_read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`sale_id`) REFERENCES `sales`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`buyer_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`seller_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_sale_buyer` ON `conversations` (`sale_id`,`buyer_id`);--> statement-breakpoint
CREATE INDEX `conversations_buyer` ON `conversations` (`buyer_id`,`last_message_at`);--> statement-breakpoint
CREATE INDEX `conversations_seller` ON `conversations` (`seller_id`,`last_message_at`);--> statement-breakpoint
CREATE TABLE `message_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`message_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`r2_key` text NOT NULL,
	`content_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`width` integer,
	`height` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `message_attachments_r2_key_unique` ON `message_attachments` (`r2_key`);--> statement-breakpoint
CREATE INDEX `message_attachments_message` ON `message_attachments` (`message_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`sender_id` text NOT NULL,
	`body` text NOT NULL,
	`payment_warning` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sender_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation` ON `messages` (`conversation_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`user_id` text PRIMARY KEY NOT NULL,
	`email_off` text DEFAULT '[]' NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `notifications` ADD `dedupe_key` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `email_status` text;--> statement-breakpoint
ALTER TABLE `notifications` ADD `email_due_at` integer;--> statement-breakpoint
ALTER TABLE `notifications` ADD `emailed_at` integer;--> statement-breakpoint
ALTER TABLE `notifications` ADD `email_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_dedupe` ON `notifications` (`dedupe_key`) WHERE "notifications"."dedupe_key" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `notifications_user_unread` ON `notifications` (`user_id`) WHERE "notifications"."read_at" IS NULL;--> statement-breakpoint
CREATE INDEX `notifications_email_due` ON `notifications` (`email_status`,`email_due_at`) WHERE "notifications"."email_status" IN ('pending', 'batched');