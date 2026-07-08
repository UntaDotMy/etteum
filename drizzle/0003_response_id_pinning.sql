-- Additive: response_id on request_logs for sticky response-id pinning.
ALTER TABLE `request_logs` ADD `response_id` text;--> statement-breakpoint
CREATE INDEX `request_logs_response_id_idx` ON `request_logs` (`response_id`);
