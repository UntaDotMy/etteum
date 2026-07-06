-- Migration: Add combos table for multi-model fallback chains
-- Version: 0001

CREATE TABLE IF NOT EXISTS combos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  models TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS combos_name_idx ON combos(name);

-- Add combo strategies to settings (JSON object keyed by combo name)
-- Format: { "combo-name": { fallbackStrategy: "fallback" | "sticky" | "fusion", judgeModel: "...", fusionTuning: {...} } }
