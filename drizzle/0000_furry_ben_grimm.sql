CREATE TABLE `accounts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`provider` text NOT NULL,
	`email` text NOT NULL,
	`password` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`tokens` text,
	`quota_limit` real DEFAULT 0,
	`quota_remaining` real DEFAULT 0,
	`quota_reset_at` integer,
	`free_limit` real DEFAULT 0,
	`free_remaining` real DEFAULT 0,
	`free_reset_at` integer,
	`last_used_at` integer,
	`last_login_at` integer,
	`error_message` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_email_idx` ON `accounts` (`provider`,`email`);--> statement-breakpoint
CREATE TABLE `filter_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`rule_id` text NOT NULL,
	`pattern` text NOT NULL,
	`replacement` text DEFAULT '' NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`is_regex` integer DEFAULT false NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `filter_rules_rule_id_unique` ON `filter_rules` (`rule_id`);--> statement-breakpoint
CREATE INDEX `filter_rules_sort_order_idx` ON `filter_rules` (`sort_order`);--> statement-breakpoint
CREATE TABLE `image_studio_chats` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`title` text,
	`messages` text NOT NULL,
	`final_prompt` text,
	`options` text,
	`assist_model` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `image_studio_chats_updated_at_idx` ON `image_studio_chats` (`updated_at`);--> statement-breakpoint
CREATE TABLE `image_studio_results` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`chat_id` integer,
	`prompt` text NOT NULL,
	`type` text DEFAULT 'image' NOT NULL,
	`aspect_ratio` text DEFAULT '1:1' NOT NULL,
	`n` integer DEFAULT 1 NOT NULL,
	`urls` text NOT NULL,
	`credits_used` real DEFAULT 0,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`chat_id`) REFERENCES `image_studio_chats`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `image_studio_results_created_at_idx` ON `image_studio_results` (`created_at`);--> statement-breakpoint
CREATE INDEX `image_studio_results_chat_idx` ON `image_studio_results` (`chat_id`);--> statement-breakpoint
CREATE TABLE `model_mappings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`source_pattern` text NOT NULL,
	`match_type` text DEFAULT 'contains' NOT NULL,
	`target_model` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`label` text,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `model_mappings_priority_idx` ON `model_mappings` (`priority`);--> statement-breakpoint
CREATE TABLE `proxy_pool` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`url` text NOT NULL,
	`type` text DEFAULT 'http' NOT NULL,
	`label` text,
	`status` text DEFAULT 'active' NOT NULL,
	`last_used_at` integer,
	`last_checked_at` integer,
	`error_message` text,
	`latency_ms` integer,
	`success_count` integer DEFAULT 0,
	`fail_count` integer DEFAULT 0,
	`created_at` integer NOT NULL,
	`updated_at` integer
);
--> statement-breakpoint
CREATE INDEX `proxy_pool_status_idx` ON `proxy_pool` (`status`);--> statement-breakpoint
CREATE TABLE `request_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`provider` text NOT NULL,
	`model` text,
	`prompt_tokens` integer DEFAULT 0,
	`completion_tokens` integer DEFAULT 0,
	`total_tokens` integer DEFAULT 0,
	`credits_used` real DEFAULT 0,
	`status` text NOT NULL,
	`duration_ms` integer,
	`error_message` text,
	`request_body` text,
	`response_body` text,
	`account_email` text,
	`account_quota_before` real DEFAULT 0,
	`account_quota_after` real DEFAULT 0,
	`compression_stats` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `request_logs_created_at_idx` ON `request_logs` (`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_status_created_at_idx` ON `request_logs` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_provider_created_at_idx` ON `request_logs` (`provider`,`created_at`);--> statement-breakpoint
CREATE INDEX `request_logs_provider_model_status_idx` ON `request_logs` (`provider`,`model`,`status`);--> statement-breakpoint
CREATE INDEX `request_logs_account_idx` ON `request_logs` (`account_id`);--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text,
	`updated_at` integer
);
--> statement-breakpoint
CREATE TABLE `usage_summary` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`bucket` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`total_requests` integer DEFAULT 0,
	`success_requests` integer DEFAULT 0,
	`error_requests` integer DEFAULT 0,
	`prompt_tokens` integer DEFAULT 0,
	`completion_tokens` integer DEFAULT 0,
	`total_tokens` integer DEFAULT 0,
	`credits_used` real DEFAULT 0,
	`total_duration_ms` integer DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX `usage_summary_bucket_provider_model_idx` ON `usage_summary` (`bucket`,`provider`,`model`);--> statement-breakpoint
CREATE INDEX `usage_summary_bucket_idx` ON `usage_summary` (`bucket`);--> statement-breakpoint
CREATE INDEX `usage_summary_provider_idx` ON `usage_summary` (`provider`,`bucket`);--> statement-breakpoint
CREATE TABLE `vcc_cards` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`number` text NOT NULL,
	`exp_month` text NOT NULL,
	`exp_year` text NOT NULL,
	`cvv` text NOT NULL,
	`name` text DEFAULT 'John Doe',
	`status` text DEFAULT 'active' NOT NULL,
	`used_by_account_id` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`used_by_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vcc_cards_status_idx` ON `vcc_cards` (`status`);--> statement-breakpoint
CREATE TABLE `vcc_transactions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`account_id` integer,
	`card_last4` text NOT NULL,
	`card_brand` text,
	`amount` real,
	`currency` text DEFAULT 'usd',
	`status` text NOT NULL,
	`stripe_charge_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `vcc_transactions_account_idx` ON `vcc_transactions` (`account_id`);--> statement-breakpoint
CREATE INDEX `vcc_transactions_status_idx` ON `vcc_transactions` (`status`);