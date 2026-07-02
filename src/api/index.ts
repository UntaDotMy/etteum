import { Hono } from "hono";
import { config } from "../config";
import { accountsRouter } from "./accounts";
import { proxySettingsRouter } from "./proxy-settings";
import { statsRouter } from "./stats";
import { keysRouter } from "./keys";
import { vccRouter } from "./vcc";
import { proxyPoolRouter } from "./proxy-pool";
import { imageStudioRouter } from "./image-studio";
import { filtersRouter } from "./filters";
import { binApi } from "./bin";
import { integrationRouter } from "./integration";
import { oauthRouter } from "./oauth";

export const apiRouter = new Hono();

apiRouter.route("/accounts", accountsRouter);
apiRouter.route("/settings", proxySettingsRouter);
apiRouter.route("/stats", statsRouter);
apiRouter.route("/keys", keysRouter);
apiRouter.route("/vcc", vccRouter);
apiRouter.route("/proxy-pool", proxyPoolRouter);
apiRouter.route("/image-studio", imageStudioRouter);
apiRouter.route("/filters", filtersRouter);
apiRouter.route("/bin", binApi);
apiRouter.route("/integration", integrationRouter);
apiRouter.route("/oauth", oauthRouter);

apiRouter.get("/providers", (c) => {
  return c.json({ data: config.providers });
});

// Health check — used by load balancers, monitoring, and doctor checks
apiRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: "1.0.0",
    uptime: Math.floor(process.uptime()),
    uptimeHuman: formatUptime(process.uptime()),
    timestamp: new Date().toISOString(),
    memory: {
      rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + "MB",
      heap: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + "MB",
    },
    platform: process.platform,
    node: process.version,
  });
});

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(" ") || "0m";
}
