import { Hono } from "hono";
import { db } from "../db/index";
import { vccCards, vccTransactions, accounts } from "../db/schema";
import { eq, and, desc } from "drizzle-orm";
import { encrypt, decrypt, isGcm } from "../utils/crypto";

const vccRouter = new Hono();

// --- PCI scope reduction: card fields are encrypted at rest (AES-256-GCM) ---
// number / expMonth / expYear / cvv are stored as `g1:` ciphertext. Legacy
// plaintext rows (pre-fix) are transparently readable via safeDecrypt and
// re-encrypted on next write. CVV storage is unavoidable for the charging
// flow today, but it is now encrypted — not plaintext on disk. PCI DSS
// Req 3.4 (render PAN unreadable) + Req 3.2.2 (CVV storage minimized).
function safeDecrypt(field: string): string {
  if (!field) return "";
  // g1: prefix → AES-256-GCM. Otherwise legacy plaintext (pre-fix row).
  if (isGcm(field)) {
    try { return decrypt(field); } catch { return ""; }
  }
  return field;
}

/** Detect brand from a plaintext card number. */
function detectBrand(num: string): string {
  const n = num.replace(/\D/g, "");
  if (n.startsWith("4")) return "visa";
  if (/^5[1-5]/.test(n) || /^2[2-7]/.test(n)) return "mastercard";
  if (/^3[47]/.test(n)) return "amex";
  if (/^6(?:011|5|22126|4[4-9])/.test(n)) return "discover";
  if (/^35(?:2[89]|[3-8])/.test(n)) return "jcb";
  if (/^62/.test(n)) return "unionpay";
  return "unknown";
}

/** Decrypted card representation (only for the charging callsite). */
interface DecryptedCard {
  number: string;
  exp: string;
  cvv: string;
  name: string;
}

vccRouter.get("/pool", async (c) => {
  const cards = await db
    .select()
    .from(vccCards)
    .where(eq(vccCards.status, "active"));

  return c.json({
    count: cards.length,
    cards: cards.map((card) => {
      const num = safeDecrypt(card.number);
      return {
        id: card.id,
        last4: num.slice(-4),
        bin: num.slice(0, 6),
        brand: detectBrand(num),
        exp: `${safeDecrypt(card.expMonth)}/${safeDecrypt(card.expYear).slice(-2)}`,
        name: card.name || "John Doe",
        status: card.status,
        createdAt: card.createdAt,
      };
    }),
  });
});

vccRouter.post("/pool", async (c) => {
  const body = await c.req.json<{ cards: { number: string; exp: string; cvv: string; name?: string }[] }>();
  if (!Array.isArray(body.cards)) {
    return c.json({ error: "cards must be an array" }, 400);
  }

  let added = 0;
  for (const card of body.cards) {
    if (!card.number || !card.exp || !card.cvv) continue;

    const number = card.number.replace(/[\s-]/g, "");
    let expMonth = "";
    let expYear = "";

    if (card.exp.includes("/")) {
      const parts = card.exp.split("/");
      expMonth = parts[0]!.trim().padStart(2, "0");
      expYear = parts[1]!.trim();
      if (expYear.length === 2) expYear = `20${expYear}`;
    }

    await db.insert(vccCards).values({
      number: encrypt(number),
      expMonth: encrypt(expMonth),
      expYear: encrypt(expYear),
      cvv: encrypt(card.cvv),
      name: card.name || "John Doe",
      status: "active",
    });
    added++;
  }

  return c.json({ added });
});

vccRouter.delete("/pool/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (isNaN(id)) return c.json({ error: "invalid id" }, 400);

  await db.delete(vccCards).where(eq(vccCards.id, id));
  return c.json({ deleted: true });
});

vccRouter.delete("/pool", async (c) => {
  await db.delete(vccCards).where(eq(vccCards.status, "active"));
  return c.json({ cleared: true });
});

vccRouter.get("/transactions", async (c) => {
  const rows = await db
    .select({
      id: vccTransactions.id,
      accountId: vccTransactions.accountId,
      cardLast4: vccTransactions.cardLast4,
      cardBrand: vccTransactions.cardBrand,
      status: vccTransactions.status,
      createdAt: vccTransactions.createdAt,
      email: accounts.email,
    })
    .from(vccTransactions)
    .leftJoin(accounts, eq(vccTransactions.accountId, accounts.id))
    .orderBy(desc(vccTransactions.createdAt))
    .limit(100);

  return c.json({ transactions: rows });
});

export function getVccPool(): { number: string; exp: string; cvv: string; name: string }[] {
  return [];
}

export async function getVccPoolFromDb(): Promise<DecryptedCard[]> {
  const activeCards = await db.select().from(vccCards).where(eq(vccCards.status, "active"));

  const cards: DecryptedCard[] = activeCards.map((card) => ({
    number: safeDecrypt(card.number),
    exp: `${safeDecrypt(card.expMonth)}/${safeDecrypt(card.expYear).slice(-2)}`,
    cvv: safeDecrypt(card.cvv),
    name: card.name || "John Doe",
  }));

  // Shuffle to avoid race conditions in concurrent processes
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j]!, cards[i]!];
  }

  return cards;
}

export async function reserveCardForAccount(accountId: number): Promise<DecryptedCard | null> {
  // Claim one active card (not all status=active rows). Retry on concurrent claim races.
  if (!Number.isInteger(accountId) || accountId <= 0) return null;

  for (let attempt = 0; attempt < 5; attempt++) {
    const [pick] = await db
      .select({ id: vccCards.id })
      .from(vccCards)
      .where(eq(vccCards.status, "active"))
      .limit(1);
    if (!pick) return null;

    const claimed = await db
      .update(vccCards)
      .set({
        status: "reserved",
        usedByAccountId: accountId,
        updatedAt: new Date(),
      })
      .where(and(eq(vccCards.id, pick.id), eq(vccCards.status, "active")))
      .returning();
    const card = claimed[0];
    if (!card) continue; // lost race — try next active card

    return {
      number: safeDecrypt(card.number),
      exp: `${safeDecrypt(card.expMonth)}/${safeDecrypt(card.expYear).slice(-2)}`,
      cvv: safeDecrypt(card.cvv),
      name: card.name || "John Doe",
    };
  }
  return null;
}

export async function releaseReservedCard(accountId: number): Promise<void> {
  await db.update(vccCards).set({
    status: "active",
    usedByAccountId: null,
    updatedAt: new Date(),
  }).where(eq(vccCards.usedByAccountId, accountId));
}

export async function handleCardResult(
  accountId: number,
  cardLast4: string,
  status: "success" | "declined" | "error"
): Promise<void> {
  const allCards = await db.select().from(vccCards);
  // Match by decrypted last4 (cards are now encrypted at rest).
  const match = allCards.find((c) => safeDecrypt(c.number).endsWith(cardLast4));
  if (match) {
    if (status === "declined") {
      await db.delete(vccCards).where(eq(vccCards.id, match.id));
    } else {
      const newStatus = status === "success" ? "used" : match.status;
      await db
        .update(vccCards)
        .set({
          status: newStatus,
          usedByAccountId: accountId,
          updatedAt: new Date(),
        })
        .where(eq(vccCards.id, match.id));
    }
  }

  // Skip txn insert if account already deleted (FK to accounts.id).
  if (Number.isInteger(accountId) && accountId > 0) {
    const [acc] = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(eq(accounts.id, accountId))
      .limit(1);
    if (acc) {
      await db.insert(vccTransactions).values({
        accountId,
        cardLast4,
        amount: 0,
        currency: "usd",
        status,
      });
    }
  }
}

/**
 * One-time migration: encrypt any legacy plaintext card rows still on disk.
 * Safe to call repeatedly — skips rows already in `g1:` format. Called at boot
 * from the migration runner. Returns the count of rows re-encrypted.
 */
export async function migrateVccEncryption(): Promise<number> {
  const allCards = await db.select().from(vccCards);
  let migrated = 0;
  for (const card of allCards) {
    if (isGcm(card.number) && isGcm(card.cvv)) continue; // already encrypted
    await db.update(vccCards).set({
      number: isGcm(card.number) ? card.number : encrypt(safeDecrypt(card.number)),
      expMonth: isGcm(card.expMonth) ? card.expMonth : encrypt(safeDecrypt(card.expMonth)),
      expYear: isGcm(card.expYear) ? card.expYear : encrypt(safeDecrypt(card.expYear)),
      cvv: isGcm(card.cvv) ? card.cvv : encrypt(safeDecrypt(card.cvv)),
      updatedAt: new Date(),
    }).where(eq(vccCards.id, card.id));
    migrated++;
  }
  return migrated;
}

export { vccRouter };
