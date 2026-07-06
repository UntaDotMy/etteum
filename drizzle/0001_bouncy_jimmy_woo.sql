CREATE TABLE `combos` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`models` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `combos_name_unique` ON `combos` (`name`);--> statement-breakpoint
CREATE INDEX `combos_name_idx` ON `combos` (`name`);--> statement-breakpoint
ALTER TABLE `request_logs` ADD `compressed_request_body` text;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `savings_by_technique` text;