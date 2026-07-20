/**
 * Operator security console: IP bans (friend-key tripwire) + audit trail.
 * Mounted under /api — the global /api middleware already requires the pool
 * key or a dashboard session, so no friend key can reach these routes.
 */

import { Hono } from "hono";
import {
  listBans,
  listSecurityEvents,
  logSecurityEvent,
  unbanIp,
} from "../utils/ip-ban";

export const securityRouter = new Hono();

/** GET /api/security/bans — active IP bans (expired rows self-reap on read). */
securityRouter.get("/bans", async (c) => {
  return c.json({ bans: await listBans() });
});

/** DELETE /api/security/bans/:ip — lift a ban (operator escape hatch). */
securityRouter.delete("/bans/:ip", async (c) => {
  const ip = c.req.param("ip");
  const removed = await unbanIp(ip);
  if (removed) {
    await logSecurityEvent({
      ip,
      surface: "api",
      path: "/api/security/bans",
      action: "unban",
      detail: "ban lifted by operator",
    });
  }
  return c.json({ removed });
});

/** GET /api/security/events?limit=N — audit trail, newest first. */
securityRouter.get("/events", async (c) => {
  const raw = Number(c.req.query("limit") || "100");
  const limit = Number.isFinite(raw) ? raw : 100;
  return c.json({ events: await listSecurityEvents(limit) });
});
