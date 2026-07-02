import { db } from "../src/db";
import { accounts } from "../src/db/schema";
import { eq } from "drizzle-orm";

async function fixByokData() {
  console.log("🔧 Fixing BYOK account data...\n");

  // Get the problematic account
  const account = await db.select().from(accounts)
    .where(eq(accounts.id, 1382))
    .get();

  if (!account) {
    console.log("❌ Account #1382 not found");
    return;
  }

  console.log("Current account status:", account.status);
  console.log("Current tokens (raw):", account.tokens);
  console.log("Type:", typeof account.tokens);

  // Parse the double-encoded tokens
  let fixedTokens;
  if (typeof account.tokens === "string") {
    try {
      // First parse to get the JSON string
      const parsed = JSON.parse(account.tokens);
      console.log("\nFirst parse result:", typeof parsed);
      console.log("Content:", parsed);
      
      // If it's still a string, parse again
      if (typeof parsed === "string") {
        fixedTokens = JSON.parse(parsed);
        console.log("\n✅ Double-decoded successfully");
      } else {
        // Already an object, use it directly
        fixedTokens = parsed;
        console.log("\n✅ Already decoded, using as-is");
      }
      
      console.log("Fixed tokens:", JSON.stringify(fixedTokens, null, 2));
    } catch (e) {
      console.error("❌ Failed to parse tokens:", e);
      return;
    }
  } else {
    console.log("✅ Tokens already in correct format");
    fixedTokens = account.tokens;
  }

  // Update the account with fixed tokens and reset status to active
  console.log("\n💾 Updating account...");
  await db.update(accounts)
    .set({
      tokens: fixedTokens,
      status: "active",
      updatedAt: new Date(),
    })
    .where(eq(accounts.id, 1382));

  console.log("✅ Account #1382 fixed successfully!");
  console.log("   - Status: error → active");
  console.log("   - Tokens: double-encoded → proper object");
}

fixByokData()
  .then(() => {
    console.log("\n✨ Done!");
    process.exit(0);
  })
  .catch((e) => {
    console.error("\n❌ Error:", e);
    process.exit(1);
  });
