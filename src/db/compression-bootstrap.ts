/**
 * Compression settings bootstrap (policy v1).
 *
 * One-shot + always-on clamp for pathological RTK values that make CLI agents
 * (Claude Code, Codex, …) re-read files and look "dumb".
 *
 * History: installs could store max_tool_chars far below the UI floor (e.g. 150)
 * from early experiments or bad API writes. Code defaults alone never fix
 * already-persisted rows — loadFromDb always wins over DEFAULT_COMPRESSION_CONFIG.
 *
 * Policy key `compression_policy_v1` records the first migration pass. Pathological
 * values (< UI min 500) are still clamped every boot so they cannot reappear.
 */
import { db } from "./index";
import { settings } from "./schema";
import { eq } from "drizzle-orm";
import { DEFAULT_COMPRESSION_CONFIG } from "../proxy/compression/types";
import { invalidateCompressionCache } from "../proxy/compression/settings";

const POLICY_KEY = "compression_policy_v1";
const POLICY_VALUE = "applied";

// v2: raise the RTK tool-result cap to the new default (4000) on installs that
// still carry an older healthy value (e.g. 1500). Unlike the v1 always-on clamp
// (which only fixes pathological <500 values), this runs ONCE per DB so a user
// who later lowers the cap in Settings is not overridden on every boot.
const POLICY_KEY_V2 = "compression_policy_v2";
const POLICY_VALUE_V2 = "applied";
const V2_TARGET_MAX = 4000;

/** Matches Settings UI min=500 for max tool chars. Below this is always a bug. */
const UI_MIN_MAX_TOOL_CHARS = 500;

const SAFE_MAX = DEFAULT_COMPRESSION_CONFIG.rtk.maxToolChars; // 4000
const SAFE_KEEP = DEFAULT_COMPRESSION_CONFIG.rtk.keepLastNTurnsFull; // 4

async function getSetting(key: string): Promise<string | null> {
  try {
    const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
    return row?.value ?? null;
  } catch {
    return null;
  }
}

async function setSetting(key: string, value: string): Promise<void> {
  const [existing] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (existing) {
    await db.update(settings).set({ value }).where(eq(settings.key, key));
  } else {
    await db.insert(settings).values({ key, value });
  }
}

/**
 * Clamp bad RTK rows and mark policy applied. Safe to call every boot.
 */
export async function bootstrapCompressionSettings(): Promise<void> {
  const maxRaw = await getSetting("compression_rtk_max_tool_chars");
  const keepRaw = await getSetting("compression_rtk_keep_last_n_turns_full");
  const maxN = maxRaw != null && maxRaw.trim() !== "" ? parseInt(maxRaw, 10) : null;
  const keepN = keepRaw != null && keepRaw.trim() !== "" ? parseInt(keepRaw, 10) : null;

  let fixed = false;

  // Pathological cap (below UI floor) — always fix.
  if (maxN != null && Number.isFinite(maxN) && maxN < UI_MIN_MAX_TOOL_CHARS) {
    await setSetting("compression_rtk_max_tool_chars", String(SAFE_MAX));
    fixed = true;
    // When the cap was garbage, also ensure a CLI-safe protected window.
    if (keepN == null || !Number.isFinite(keepN) || keepN < SAFE_KEEP) {
      await setSetting("compression_rtk_keep_last_n_turns_full", String(SAFE_KEEP));
    }
  }

  // Non-numeric garbage.
  if (maxRaw != null && maxRaw.trim() !== "" && (maxN == null || !Number.isFinite(maxN))) {
    await setSetting("compression_rtk_max_tool_chars", String(SAFE_MAX));
    fixed = true;
  }
  if (keepRaw != null && keepRaw.trim() !== "" && (keepN == null || !Number.isFinite(keepN))) {
    await setSetting("compression_rtk_keep_last_n_turns_full", String(SAFE_KEEP));
    fixed = true;
  }

  // Negative / absurd keep window.
  if (keepN != null && Number.isFinite(keepN) && keepN < 0) {
    await setSetting("compression_rtk_keep_last_n_turns_full", String(SAFE_KEEP));
    fixed = true;
  }

  const applied = await getSetting(POLICY_KEY);
  if (applied !== POLICY_VALUE) {
    await setSetting(POLICY_KEY, POLICY_VALUE);
    if (fixed) {
      console.log(
        `[DB] Applied compression policy v1 — RTK max→${SAFE_MAX}, keep≥${SAFE_KEEP} (pathological values fixed)`,
      );
    } else {
      console.log("[DB] Applied compression policy v1 — RTK settings already safe");
    }
  } else if (fixed) {
    console.log(
      `[DB] Clamped pathological RTK settings (max≥${UI_MIN_MAX_TOOL_CHARS}, defaults ${SAFE_MAX}/${SAFE_KEEP})`,
    );
  }

  // One-time v2 migration: bump any healthy-but-stale cap (>= UI floor, < target)
  // up to the new default. Runs once so later manual Settings changes win.
  const appliedV2 = await getSetting(POLICY_KEY_V2);
  if (appliedV2 !== POLICY_VALUE_V2) {
    const cur = await getSetting("compression_rtk_max_tool_chars");
    const curN = cur != null && cur.trim() !== "" ? parseInt(cur, 10) : null;
    if (curN != null && Number.isFinite(curN) && curN >= UI_MIN_MAX_TOOL_CHARS && curN < V2_TARGET_MAX) {
      await setSetting("compression_rtk_max_tool_chars", String(V2_TARGET_MAX));
      console.log(`[DB] Applied compression policy v2 — RTK max_tool_chars ${curN}→${V2_TARGET_MAX}`);
      invalidateCompressionCache();
    }
    await setSetting(POLICY_KEY_V2, POLICY_VALUE_V2);
  }

  if (fixed) invalidateCompressionCache();
}
