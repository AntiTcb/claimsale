-- WS-J: the chosen shipping option's label snapshot, and the shipping export layout. Expand only.
ALTER TABLE `invoices` ADD `shipping_option_label` text;--> statement-breakpoint
ALTER TABLE `io_jobs` ADD `layout` text;