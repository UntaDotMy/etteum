/**
 * Log rotation utility — rotates log files when they exceed a size threshold.
 *
 * Usage:
 *   import { setupLogRotation } from "./utils/log-rotation";
 *   setupLogRotation();  // call once at startup
 *
 * Rotates: .etteum.log, .etteum.log.stdout, .etteum.log.stderr, .aiproxy.log
 * Keeps the last 5 rotated files per log.
 */

import { existsSync, statSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
const MAX_ROTATED_FILES = 5;

const LOG_FILES = [
  ".etteum.log",
  ".etteum.log.stdout",
  ".etteum.log.stderr",
  ".aiproxy.log",
];

export function setupLogRotation(): void {
  // Check every 5 minutes
  const interval = setInterval(() => {
    for (const logFile of LOG_FILES) {
      rotateIfNeeded(logFile);
    }
  }, 5 * 60 * 1000);

  // Don't keep the process alive just for log rotation
  interval.unref();

  // Also check once at startup
  for (const logFile of LOG_FILES) {
    rotateIfNeeded(logFile);
  }
}

function rotateIfNeeded(logFile: string): void {
  const filePath = join(ROOT, logFile);
  if (!existsSync(filePath)) return;

  const stats = statSync(filePath);
  if (stats.size < MAX_SIZE_BYTES) return;

  // Rotate: file.log -> file.log.1, file.log.1 -> file.log.2, etc.
  for (let i = MAX_ROTATED_FILES - 1; i >= 1; i--) {
    const src = `${filePath}.${i}`;
    const dst = `${filePath}.${i + 1}`;
    if (existsSync(src)) {
      try {
        renameSync(src, dst);
      } catch {
        // ignore rename failures
      }
    }
  }

  // Move current log to .1
  try {
    renameSync(filePath, `${filePath}.1`);
  } catch {
    // ignore rename failures
  }

  // Delete oldest rotated file if it exists
  const oldest = `${filePath}.${MAX_ROTATED_FILES + 1}`;
  if (existsSync(oldest)) {
    try {
      unlinkSync(oldest);
    } catch {
      // ignore
    }
  }
}
