/**
 * Backup export / import API — migrate full Etteum state between PCs.
 *
 * GET  /api/backup/status
 * POST /api/backup/export   { mode?: "essential"|"full" } → creates pack, returns path (+ zip if possible)
 * GET  /api/backup/download?dir=...  → stream zip if exists, else 404 with path hint
 * POST /api/backup/import   multipart file (zip) or JSON { dir: "..." }
 *        ?confirm=1 required for replace
 *        ?mode=merge|replace  (default merge — append accounts, no duplicates)
 */
import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  applyBackupDir,
  createBackupDir,
  mergeAccountsFromPack,
  resolveImportSource,
  zipBackupDir,
  type BackupMode,
  type ImportMode,
} from "../lib/backup";
import { client as sqlite } from "../db/index";
import { config } from "../config";
import { pool } from "../proxy/pool";
import { broadcast } from "../ws/index";

export const backupRouter = new Hono();

function tableCount(name: string): number {
  try {
    const row = sqlite.query(`SELECT COUNT(*) AS n FROM "${name}"`).get() as { n: number };
    return Number(row?.n ?? 0);
  } catch {
    return 0;
  }
}

function projectRoot(): string {
  return path.resolve(import.meta.dir, "../..");
}

backupRouter.get("/status", (c) => {
  return c.json({
    data: {
      accounts: tableCount("accounts"),
      settings: tableCount("settings"),
      apiKeys: tableCount("api_keys"),
      proxyPool: tableCount("proxy_pool"),
      requestLogs: tableCount("request_logs"),
      filterRules: tableCount("filter_rules"),
      combos: tableCount("combos"),
      modelMappings: tableCount("model_mappings"),
      vccCards: tableCount("vcc_cards"),
      databasePath: config.databasePath,
    },
  });
});

/**
 * Create a backup pack on disk.
 * Body/query: mode=essential|full (default essential — no request history).
 */
backupRouter.post("/export", async (c) => {
  try {
    let mode: BackupMode = "essential";
    try {
      const body = await c.req.json().catch(() => ({}));
      if (body?.mode === "full") mode = "full";
    } catch {
      /* empty */
    }
    if (c.req.query("mode") === "full") mode = "full";

    const summary = createBackupDir(mode);
    const zipPath = await zipBackupDir(summary.dir);
    summary.zipPath = zipPath || undefined;

    return c.json({
      data: {
        ...summary,
        // Relative paths for display
        dir: summary.dir,
        zipPath: summary.zipPath ?? null,
        downloadUrl: summary.zipPath
          ? `/api/backup/download?file=${encodeURIComponent(path.basename(summary.zipPath))}`
          : null,
        hint: summary.zipPath
          ? "Download the zip, or copy the folder to the other PC."
          : "Zip unavailable — copy the backup folder to the other PC (path in dir).",
      },
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Download a zip from data/backups/ by basename only (no path traversal). */
backupRouter.get("/download", (c) => {
  const file = c.req.query("file") || "";
  if (!file || file.includes("..") || file.includes("/") || file.includes("\\")) {
    return c.json({ error: "Invalid file" }, 400);
  }
  if (!file.endsWith(".zip")) {
    return c.json({ error: "Only .zip downloads are supported via this endpoint" }, 400);
  }
  const abs = path.join(projectRoot(), "data", "backups", file);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    return c.json({ error: "File not found" }, 404);
  }
  const buf = readFileSync(abs);
  return new Response(buf, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${file}"`,
      "Cache-Control": "no-store",
    },
  });
});

/**
 * Import backup. Accepts:
 *   - multipart field "file" = .zip
 *   - JSON { path: "absolute or relative pack path or zip", mode?: "merge"|"replace" }
 *
 * Query:
 *   mode=merge|replace  (default merge)
 *   confirm=1           required only for replace (full DB wipe)
 *
 * merge  — append accounts by (provider,email); update if present; no restart
 * replace — swap entire DB + .env; requires confirm + full process restart
 */
backupRouter.post("/import", async (c) => {
  const qMode = (c.req.query("mode") || "").toLowerCase();
  let mode: ImportMode =
    qMode === "replace" ? "replace" : qMode === "merge" ? "merge" : "merge";

  try {
    const ct = c.req.header("content-type") || "";
    let sourcePath: string;
    let bodyMode: string | undefined;

    if (ct.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: "multipart field 'file' required (zip)" }, 400);
      }
      const f = file as File;
      const name = f.name || "upload.zip";
      const dest = path.join(
        projectRoot(),
        "data",
        "backups",
        `upload-${Date.now()}-${name.replace(/[^\w.\-]+/g, "_")}`,
      );
      await Bun.write(dest, f);
      sourcePath = dest;
      if (typeof body["mode"] === "string") bodyMode = body["mode"];
    } else {
      const body = (await c.req.json().catch(() => ({}))) as {
        path?: string;
        dir?: string;
        mode?: string;
      };
      bodyMode = body.mode;
      const p = body.path || body.dir;
      if (!p) {
        return c.json(
          { error: "JSON body must include path (backup folder or .zip)" },
          400,
        );
      }
      sourcePath = p;
    }

    if (!qMode && bodyMode) {
      const bm = bodyMode.toLowerCase();
      if (bm === "replace" || bm === "merge") mode = bm;
    }

    if (mode === "replace") {
      const confirm = c.req.query("confirm");
      if (confirm !== "1" && confirm !== "true") {
        return c.json(
          {
            error:
              "Full replace overwrites this PC's database and .env. " +
              "Re-send with ?mode=replace&confirm=1, or use mode=merge to append accounts only.",
          },
          400,
        );
      }
    }

    const packDir = await resolveImportSource(sourcePath);

    if (mode === "merge") {
      const result = mergeAccountsFromPack(packDir);
      // Live connection already holds the new rows — clear all provider caches.
      pool.invalidate();
      if (result.inserted + result.updated > 0) {
        broadcast({
          type: "accounts_updated",
          data: {
            source: "backup-merge",
            inserted: result.inserted,
            updated: result.updated,
          },
        });
      }
      return c.json({ data: result });
    }

    const result = applyBackupDir(packDir);
    return c.json({ data: result });
  } catch (e) {
    return c.json(
      {
        error: e instanceof Error ? e.message : String(e),
        hint:
          mode === "replace"
            ? "If the DB is locked: etteum stop → bun scripts/backup.ts import <zip> --yes → etteum start"
            : "Merge import failed — check pack has manifest.json + poolprox3.db + env",
      },
      500,
    );
  }
});
