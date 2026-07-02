/**
 * Live-probe Qoder quota for specific accounts, bypassing DB cache.
 * Hits /quota/usage and /algo/api/v2/activity directly using stored tokens.
 *
 * Usage: bun scripts/check-qoder-live.ts <id1> <id2> ...
 */
import { Database } from "bun:sqlite";
import { bearerFetch } from "../src/proxy/providers/qoder";

const DB_PATH = "./data/poolprox3.db";
const QOTA_USAGE_URL = "https://openapi.qoder.sh/api/v2/quota/usage";
const ACTIVITY_URL = "https://openapi.qoder.sh/algo/api/v2/activity";

const ids = process.argv.slice(2).map((s) => Number(s)).filter((n) => Number.isFinite(n));
if (ids.length === 0) {
  console.error("usage: bun scripts/check-qoder-live.ts <id> [id...]");
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
const placeholders = ids.map(() => "?").join(",");
const rows = db
  .prepare(`SELECT id, email, status, free_remaining, free_limit, free_reset_at, tokens FROM accounts WHERE id IN (${placeholders})`)
  .all(...ids) as Array<{
    id: number;
    email: string;
    status: string;
    free_remaining: number;
    free_limit: number;
    free_reset_at: number | null;
    tokens: string;
  }>;

function fmtTs(ts: number | null | undefined): string {
  if (!ts) return "n/a";
  const ms = ts < 1e12 ? ts * 1000 : ts;
  return new Date(ms).toLocaleString("en-GB", { timeZone: "Asia/Jakarta" });
}

for (const row of rows) {
  console.log("━".repeat(70));
  console.log(`id=${row.id}  ${row.email}`);
  console.log(`DB     : status=${row.status}  free=${row.free_remaining}/${row.free_limit}  resetAt=${fmtTs(row.free_reset_at)}`);

  const tokens = JSON.parse(row.tokens || "{}");
  if (!tokens.securityOauthToken && !tokens.personalToken) {
    console.log("  ✗ no auth tokens");
    continue;
  }

  // /quota/usage uses Bearer securityOauthToken (openApiHeaders)
  try {
    const resp = await fetch(QOTA_USAGE_URL, {
      method: "GET",
      headers: {
        authorization: `Bearer ${tokens.securityOauthToken}`,
        accept: "application/json",
        "user-agent": "Go-http-client/2.0",
      },
    });
    const text = await resp.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 200) }; }
    if (!resp.ok) {
      console.log(`Qoder /quota/usage HTTP ${resp.status}: ${text.slice(0, 200)}`);
    } else {
      const uq = data.userQuota || {};
      console.log(`Qoder /quota/usage: limit=${uq.total} used=${uq.used} remaining=${uq.remaining} expiresAt=${fmtTs(data.expiresAt)} isQuotaExceeded=${data.isQuotaExceeded}`);
    }
  } catch (e) {
    console.log(`/quota/usage error:`, e instanceof Error ? e.message : e);
  }

  // /activity uses COSY-signed bearer (bearerFetch)
  try {
    const resp = await bearerFetch(tokens as any, { url: ACTIVITY_URL, method: "GET" });
    const text = await resp.text();
    let data: any;
    try { data = JSON.parse(text); } catch { data = { _raw: text.slice(0, 300) }; }
    if (!resp.ok) {
      console.log(`Qoder /activity HTTP ${resp.status}: ${text.slice(0, 200)}`);
    } else {
      const acts = data?.data?.activities || [];
      const queryAt = data?.data?.queryAt;
      console.log(`Qoder /activity queryAt=${fmtTs(queryAt)} activities=${acts.length}`);
      for (const a of acts) {
        const bucket = a.subjectKey || a.subject_key || a.modelKey || a.activityKey;
        const limit = a.limit ?? a.total ?? a.quota;
        const remaining = a.remaining ?? a.left;
        const resetAt = a.resetAt ?? a.reset_at ?? a.expireAt;
        console.log(`           bucket=${bucket}  remaining=${remaining}/${limit}  resetAt=${fmtTs(resetAt)}`);
      }
    }
  } catch (e) {
    console.log(`/activity error:`, e instanceof Error ? e.message : e);
  }
}

db.close();
