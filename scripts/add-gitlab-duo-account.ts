/**
 * Add a GitLab Duo account using the running etteum API.
 *
 * Usage (env or args):
 *   GITLAB_DUO_PAT=<pat> bun scripts/add-gitlab-duo-account.ts
 *   bun scripts/add-gitlab-duo-account.ts --pat <pat> [--base-url https://gitlab.com] [--label myaccount]
 *
 * The script also auto-loads from ~/.gitlab/storage.json if present
 * (the same file the GitLab Duo CLI uses), so you can run it with no args.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const args = Bun.argv.slice(2);
function arg(name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

let pat = arg("--pat") ?? process.env.GITLAB_DUO_PAT ?? "";
let baseUrl = arg("--base-url") ?? process.env.GITLAB_URL ?? "";
const label = arg("--label") ?? "";

// Fallback to GitLab Duo CLI's storage.json so users who already use `duo`
// can onboard with no secrets handling.
if (!pat || !baseUrl) {
  try {
    const storage = JSON.parse(
      readFileSync(join(homedir(), ".gitlab", "storage.json"), "utf8"),
    );
    const cfg = storage["duo-cli-config"];
    if (cfg) {
      pat = pat || cfg.gitlabAuthToken;
      baseUrl = baseUrl || cfg.gitlabBaseUrl;
      console.log("[info] using credentials from ~/.gitlab/storage.json");
    }
  } catch {
    // ignore — user will get a clearer error below if pat is still missing
  }
}

if (!pat) {
  console.error("error: PAT not provided. Set GITLAB_DUO_PAT, pass --pat <token>, or login with the duo CLI first.");
  process.exit(1);
}
baseUrl = (baseUrl || "https://gitlab.com").replace(/\/$/, "");

const ETTEUM_PORT = process.env.ETTEUM_PORT ?? "1930";
const ETTEUM_HOST = process.env.ETTEUM_HOST ?? "127.0.0.1";
const ETTEUM_URL = `http://${ETTEUM_HOST}:${ETTEUM_PORT}`;
const ETTEUM_API_KEY = process.env.ETTEUM_API_KEY ?? process.env.API_KEY ?? "pool-proxy-secret-key";

console.log(`[req] POST ${ETTEUM_URL}/api/accounts/gitlab-duo  base=${baseUrl} pat-len=${pat.length}`);

const res = await fetch(`${ETTEUM_URL}/api/accounts/gitlab-duo`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Authorization: `Bearer ${ETTEUM_API_KEY}`,
  },
  body: JSON.stringify({ gitlab_base_url: baseUrl, pat, label: label || undefined }),
});
const text = await res.text();
let json: any;
try { json = JSON.parse(text); } catch { json = { raw: text }; }

if (!res.ok) {
  console.error(`[fail] HTTP ${res.status}: ${JSON.stringify(json, null, 2)}`);
  process.exit(2);
}
console.log(`[ok] account created:`);
console.log(JSON.stringify(json, null, 2));
