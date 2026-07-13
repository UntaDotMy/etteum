/**
 * Backup export / import API — migrate full Etteum state between PCs.
 *
 * GET  /api/backup/status
 * POST /api/backup/export   { mode?: "essential"|"full" } → creates pack, returns path (+ zip if possible)
 * GET  /api/backup/download?dir=...  → stream zip if exists, else 404 with path hint
 * POST /api/backup/import   multipart file (zip) or JSON { dir: "..." } with ?confirm=1
 */
import { Hono } from "hono";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import {
  applyBackupDir,
  createBackupDir,
  resolveImportSource,
  zipBackupDir,
  type BackupMode,
} from "../lib/backup";
import { client as sqlite } from "../db/index";
import { config } from "../config";

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
 *   - JSON { path: "absolute or relative pack path or zip" }
 * Requires ?confirm=1
 */
backupRouter.post("/import", async (c) => {
  const confirm = c.req.query("confirm");
  if (confirm !== "1" && confirm !== "true") {
    return c.json(
      {
        error:
          "Import replaces this PC's database and .env. Re-send with ?confirm=1 to proceed.",
      },
      400,
    );
  }

  try {
    const ct = c.req.header("content-type") || "";
    let sourcePath: string;

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
    } else {
      const body = (await c.req.json().catch(() => ({}))) as { path?: string; dir?: string };
      const p = body.path || body.dir;
      if (!p) {
        return c.json(
          { error: "JSON body must include path (backup folder or .zip)" },
          400,
        );
      }
      sourcePath = p;
    }

    const packDir = await resolveImportSource(sourcePath);
    const result = applyBackupDir(packDir);
    return c.json({ data: result });
  } catch (e) {
    return c.json(
      {
        error: e instanceof Error ? e.message : String(e),
        hint: "If the DB is locked: etteum stop → import → etteum start",
      },
      500,
    );
  }
});
