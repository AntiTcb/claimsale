CREATE TABLE `catalog_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`set_id` integer NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`number` text,
	`rarity` text,
	`product_type` text,
	`tcgplayer_product_id` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`set_id`) REFERENCES `catalog_sets`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "catalog_products_kind" CHECK("catalog_products"."kind" IN ('single', 'sealed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_products_tcgplayer_product_id_unique` ON `catalog_products` (`tcgplayer_product_id`);--> statement-breakpoint
CREATE INDEX `catalog_products_set` ON `catalog_products` (`set_id`);--> statement-breakpoint
CREATE TABLE `catalog_sets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`game_id` text NOT NULL,
	`code` text,
	`name` text NOT NULL,
	`release_date` text,
	`tcgplayer_group_id` integer NOT NULL,
	`external_ids` text DEFAULT '{}' NOT NULL,
	`synced_build` text,
	`synced_at` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`game_id`) REFERENCES `games`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_sets_tcgplayer_group_id_unique` ON `catalog_sets` (`tcgplayer_group_id`);--> statement-breakpoint
CREATE INDEX `catalog_sets_game_sync` ON `catalog_sets` (`game_id`,`synced_build`);--> statement-breakpoint
CREATE TABLE `games` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`condition_scale` text DEFAULT '[]' NOT NULL,
	`finishes` text DEFAULT '[]' NOT NULL,
	`languages` text DEFAULT '[]' NOT NULL,
	`tcgplayer_category_id` integer,
	`enabled` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`synced_build` text,
	`synced_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `games_slug_unique` ON `games` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `games_tcgplayer_category_id_unique` ON `games` (`tcgplayer_category_id`);--> statement-breakpoint
CREATE TABLE `market_prices` (
	`product_id` integer NOT NULL,
	`subtype` text NOT NULL,
	`market_cents` integer,
	`as_of` integer NOT NULL,
	PRIMARY KEY(`product_id`, `subtype`),
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `want_list_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`product_id` integer NOT NULL,
	`finish` text,
	`max_price_cents` integer,
	`min_condition` text,
	`language` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`product_id`) REFERENCES `catalog_products`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `want_list_items_user` ON `want_list_items` (`user_id`);--> statement-breakpoint
CREATE INDEX `want_list_items_product` ON `want_list_items` (`product_id`);