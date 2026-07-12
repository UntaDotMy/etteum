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
import { updateRouter } from "./update";
import { browserSessionRouter } from "./browser-session";
import { combosRouter } from "./combos";
import { dashboardAuthRouter } from "./dashboardAuth";
import { managementRouter } from "./management";
import { debugRouter } from "./debug";
import { automationRouter } from "./automation";
import { grokFarmRouter } from "./grok-farm";
import { mitmRouter } from "./mitm";
import { playgroundRouter } from "./playground";
import { providerNodesRouter } from "./provider-nodes";

export const apiRouter = new Hono();

apiRouter.route("/accounts", accountsRouter);
apiRouter.route("/settings", proxySettingsRouter);
apiRouter.route("/stats", statsRouter);
apiRouter.route("/keys", keysRouter);
apiRouter.route("/vcc", vccRouter);
apiRouter.route("/proxy-pool", proxyPoolRouter);
apiRouter.route("/image-studio", imageStudioRouter);
apiRouter.route("/filters", filtersRouter);
apiRouter.route("/combos", combosRouter);
apiRouter.route("/dashboard-auth", dashboardAuthRouter);
apiRouter.route("/", managementRouter);
apiRouter.route("/", debugRouter);
apiRouter.route("/bin", binApi);
apiRouter.route("/integration", integrationRouter);
apiRouter.route("/oauth", oauthRouter);
apiRouter.route("/automation", automationRouter); // F5: bulk-import job framework
apiRouter.route("/grok-farm", grokFarmRouter); // Grok account farmer → provider feed
apiRouter.route("/mitm", mitmRouter); // F10: MITM intercepting server control
apiRouter.route("/playground", playgroundRouter); // F14: basic-chat + skills + translator-live
apiRouter.route("/provider-nodes", providerNodesRouter); // F13: dynamic compatible-node providers
apiRouter.route("/update", updateRouter);
apiRouter.route("/browser-sessions", browserSessionRouter);
// Singular alias — the dashboard's browserApi.ts calls per-session routes as
// /api/browser-session/:sessionId/{frames,input,captcha,cancel} (singular),
// while the list call uses /api/browser-sessions (plural). Mounting the same
// router under both paths keeps the frontend's existing URLs working without a
// dashboard rebuild.
apiRouter.route("/browser-session", browserSessionRouter);

apiRouter.get("/providers", (c) => {
  return c.json({ data: config.providers });
});

// Health check — used by load balancers, monitoring, and doctor checks
apiRouter.get("/health", (c) => {
  return c.json({
    status: "ok",
    version: config.buildVersion,
    commit: config.buildCommit,
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
