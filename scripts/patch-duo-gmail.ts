// One-shot: patch the two GitLab Duo rows we just inserted to also store the
// Gmail credentials inside tokens.gmailEmail and metadata.gmailPasswordEncrypted
// (matches the schema createGitlabDuoAccount produces when gmailEmail/Password
// are passed in).
import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { encrypt } from "../src/utils/crypto";

const PATCHES: Array<{ id: number; gmailEmail: string; gmailPassword: string }> = [
  { id: 2181, gmailEmail: "DanendraAbimanaRahmadani@gmilil.com", gmailPassword: "qwertyui" },
  { id: 2182, gmailEmail: "AbimanaNazwaSaputro@gmilil.com",       gmailPassword: "qwertyui" },
];

for (const p of PATCHES) {
  const existing = await db.select().from(accounts).where(eq(accounts.id, p.id));
  const row = existing[0];
  if (!row) {
    console.log(`[patch] id=${p.id} not found — skipping`);
    continue;
  }
  const tokens = { ...(row.tokens as Record<string, unknown> ?? {}), gmailEmail: p.gmailEmail };
  const metadata = {
    ...(row.metadata as Record<string, unknown> ?? {}),
    gmailPasswordEncrypted: encrypt(p.gmailPassword),
  };
  await db.update(accounts)
    .set({ tokens, metadata, updatedAt: new Date() })
    .where(eq(accounts.id, p.id));
  console.log(`[patch] id=${p.id} (${p.gmailEmail}) — tokens.gmailEmail set, metadata.gmailPasswordEncrypted set`);
}
console.log("[patch] done");
process.exit(0);
