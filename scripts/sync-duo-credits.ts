// One-shot: pull GitLab Credits balance from `trialUsage` and write to
// accounts.{quotaLimit,quotaRemaining,quotaResetAt} for every active
// gitlab-duo account. Run after a fresh signup or when you want to force a
// quota refresh outside the warmup loop.
import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { decrypt } from "../src/utils/crypto";

const all = await db.select().from(accounts).where(eq(accounts.provider, "gitlab-duo"));
console.log(`[sync-duo-credits] scanning ${all.length} gitlab-duo accounts`);

for (const a of all) {
  if (!a.enabled) {
    console.log(`  skip id=${a.id} (disabled)`);
    continue;
  }
  if (a.status === "error" || a.status === "pending") {
    console.log(`  skip id=${a.id} (status=${a.status}, needs re-login)`);
    continue;
  }
  const tokens = (typeof a.tokens === "string" ? JSON.parse(a.tokens) : a.tokens) as
    | { gitlabBaseUrl?: string; namespacePath?: string; userId?: number }
    | null;
  if (!tokens?.gitlabBaseUrl || !tokens.namespacePath) {
    console.log(`  skip id=${a.id} (missing tokens)`);
    continue;
  }
  const pat = decrypt(a.password);
  const r = await fetch(`${tokens.gitlabBaseUrl}/api/graphql`, {
    method: "POST",
    headers: {
      "Private-Token": pat,
      "Content-Type": "application/json",
      "User-Agent": "etteum-pool/gitlab-duo",
    },
    body: JSON.stringify({
      operationName: "getTrialUsage",
      query: `query getTrialUsage($namespacePath: ID) {
        trialUsage(namespacePath: $namespacePath) {
          activeTrial { startDate endDate }
          usersUsage {
            users(first: 50) {
              nodes { id username usage { creditsUsed totalCredits } }
            }
          }
        }
      }`,
      variables: { namespacePath: tokens.namespacePath },
    }),
  });
  if (!r.ok) {
    console.log(`  id=${a.id} ${a.email}: HTTP ${r.status}`);
    continue;
  }
  const j = (await r.json()) as any;
  const trial = j?.data?.trialUsage;
  const nodes = trial?.usersUsage?.users?.nodes ?? [];
  const ourGid = tokens.userId ? `gid://gitlab/User/${tokens.userId}` : null;
  const me =
    nodes.find((n: any) => ourGid && n.id === ourGid) ??
    nodes[0];
  const used = me?.usage?.creditsUsed;
  const total = me?.usage?.totalCredits;
  if (typeof used !== "number" || typeof total !== "number") {
    console.log(`  id=${a.id} ${a.email}: no per-user wallet (nodes=${nodes.length})`);
    continue;
  }
  const endDate = trial?.activeTrial?.endDate ? new Date(trial.activeTrial.endDate) : null;
  // If the account got falsely flipped to "exhausted" by the old warmup logic
  // (sentinel -1 misread as drained), repair the status as long as the live
  // credits actually have headroom.
  const remaining = Math.max(0, total - used);
  const nextStatus: "active" | "exhausted" =
    remaining > 0 ? "active" : "exhausted";
  await db.update(accounts)
    .set({
      status: nextStatus,
      errorMessage: nextStatus === "active" ? null : "Quota exhausted",
      quotaLimit: total,
      quotaRemaining: remaining,
      quotaResetAt: endDate && !isNaN(endDate.getTime()) ? endDate : null,
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, a.id));
  console.log(`  id=${a.id} ${a.email}: ${used.toFixed(2)}/${total} credits (${remaining.toFixed(2)} remaining), status=${nextStatus}, expires ${endDate?.toISOString().slice(0,10)}`);
}
console.log("[sync-duo-credits] done");
process.exit(0);
