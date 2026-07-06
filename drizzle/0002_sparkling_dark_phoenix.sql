CREATE TABLE `api_keys` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`key` text NOT NULL,
	`name` text,
	`machine_id` text,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`last_used_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_key_unique` ON `api_keys` (`key`);--> statement-breakpoint
CREATE INDEX `api_keys_key_idx` ON `api_keys` (`key`);--> statement-breakpoint
CREATE INDEX `api_keys_active_idx` ON `api_keys` (`is_active`);--> statement-breakpoint
CREATE TABLE `kv` (
	`scope` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `kv_scope_idx` ON `kv` (`scope`);--> statement-breakpoint
CREATE UNIQUE INDEX `kv_scope_key_idx` ON `kv` (`scope`,`key`);--> statement-breakpoint
ALTER TABLE `accounts` ADD `cooldown_until` integer;--> statement-breakpoint
ALTER TABLE `accounts` ADD `consecutive_transient_failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `next_backoff_ms` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `consecutive_auth_errors` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `accounts` ADD `priority` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `combos` ADD `kind` text DEFAULT 'fallback' NOT NULL;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `api_key_id` integer;--> statement-breakpoint
ALTER TABLE `request_logs` ADD `cost` real;--> statement-breakpoint
CREATE INDEX `request_logs_api_key_idx` ON `request_logs` (`api_key_id`);--> statement-breakpoint
ALTER TABLE `usage_summary` ADD `api_key_id` integer;--> statement-breakpoint
ALTER TABLE `usage_summary` ADD `total_cost` real DEFAULT 0;--> statement-breakpoint
CREATE INDEX `usage_summary_api_key_idx` ON `usage_summary` (`api_key_id`);