import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { loginAccount, loginAllProviders, applyProviderResult, markLoginFailed } from "./runner";
import { registerSession, getSession, listSessions, updateFrame, updatePhase, updateChallenge, clearChallenge, deleteSession, appendStep } from "./browserSession";
import { encrypt, decrypt } from "../utils/crypto";
import { broadcast } from "../ws/index";
import type { Account } from "../db/schema";
import { addAuthLog } from "./logs";
import { config } from "../config";
import { handleCardResult } from "../api/vcc";

interface QueueItem {
  accountId: number;
  retries: number;
  headless?: boolean;
  browserEngine?: string;
  generation: number;
}

interface BulkAddItem {
  email: string;
  password: string;
  providers: string[]; // ["kiro", "codebuddy", "canva"]
}

/** Options threaded from the dashboard through to batch_login.py / login.py. */
export interface LoginRunOptions {
  headless?: boolean;
  browserEngine?: string;
  concurrency?: number;
  maxRetries?: number;
}

class LoginQueue {
  private queue: QueueItem[] = [];
  private processing = false;
  private concurrency = 2; // Max concurrent logins
  private activeJobs = 0;
  private maxRetries = 3;
  private totalProcessed = 0;
  private totalSuccess = 0;
  private totalFailed = 0;
  private activeAccountIds = new Set<number>();
  private retryTimers = new Map<number, ReturnType<typeof setTimeout>>();
  private clearGeneration = 0;
  // Phase 2: the single batch_login.py process driving the current batch
  // (null when idle). clear() terminates it. Typed loosely because the
  // stdin:"pipe" variant widens the Bun.spawn generic.
  private batchProc: any = null;
  private _firstFrameSeen = false;
  private batchStdinWriter: { write: (chunk: Uint8Array) => Promise<void>; close: () => Promise<void> } | null = null;
  private batchGeneration = 0;

  /**
   * Add an account to the login queue
   */
  enqueue(accountId: number, options: { headless?: boolean; browserEngine?: string } = {}): void {
    // Avoid duplicates
    if (this.hasPendingOrActive(accountId)) {
      return;
    }
    this.queue.push({ accountId, retries: 0, headless: options.headless, browserEngine: options.browserEngine, generation: this.clearGeneration });
    const log = addAuthLog({
      type: "queue_added",
      accountId,
      message: `Account #${accountId} queued for login`,
    });
    broadcast({ type: "queue_added", data: log });
    this.process();
  }

  /**
   * Add multiple accounts to the queue
   */
  enqueueBulk(accountIds: number[], options: { headless?: boolean; browserEngine?: string } = {}): void {
    for (const id of accountIds) {
      this.enqueue(id, options);
    }
  }

  /**
   * Queue all pending accounts for login
   */
  async queueAllPending(options: { headless?: boolean; browserEngine?: string; concurrency?: number; maxRetries?: number } = {}): Promise<number> {
    if (options.concurrency !== undefined) this.setConcurrency(options.concurrency);
    if (options.maxRetries !== undefined) this.setMaxRetries(options.maxRetries);

    // Providers that use API keys / PATs / OAuth — not browser login.
    // codebuddy-china uses static ck_ keys; byok uses user-supplied keys;
    // youmind uses sk-ym- API keys. Queueing them for browser login would
    // spawn the Python script which doesn't know about them → "Provider X
    // not found in result" error.
    const nonLoginable = new Set(["byok", "codebuddy-china", "youmind"]);

    const pendingAccounts = await db
      .select()
      .from(accounts)
      .where(eq(accounts.status, "pending"));

    let queued = 0;
    for (const acc of pendingAccounts) {
      if (nonLoginable.has(acc.provider)) continue;
      this.enqueue(acc.id, options);
      queued++;
    }

    return queued;
  }

  /**
   * Bulk add accounts: creates DB entries for each provider, then queues login.
   * Input: array of { email, password, providers }
   * This handles the case where one email is used across multiple providers.
   */
  async bulkAdd(items: BulkAddItem[], options: { headless?: boolean; concurrency?: number; browserEngine?: string; maxRetries?: number } = {}): Promise<{ created: number; queued: number }> {
    let created = 0;
    const accountIds: number[] = [];

    for (const item of items) {
      for (const provider of item.providers) {
        if (!config.providers.includes(provider as typeof config.providers[number])) continue;

        try {
          const [newAccount] = await db
            .insert(accounts)
            .values({
              provider,
              email: item.email,
              password: encrypt(item.password),
              status: "pending",
            })
            .onConflictDoNothing()
            .returning();

          if (newAccount) {
            created++;
            accountIds.push(newAccount.id);
          }
        } catch {
          // Skip duplicates
        }
      }
    }

    if (options.concurrency !== undefined) this.setConcurrency(options.concurrency);
    if (options.maxRetries !== undefined) this.setMaxRetries(options.maxRetries);

    // Queue all created accounts for login
    this.enqueueBulk(accountIds, { headless: options.headless, browserEngine: options.browserEngine });

    return { created, queued: accountIds.length };
  }

  /**
   * Bulk add with ALL providers (kiro + codebuddy + canva) for each email
   */
  async bulkAddAllProviders(
    credentials: Array<{ email: string; password: string }>
  ): Promise<{ created: number; queued: number }> {
    // Use all login-capable providers (excludes byok which is key-based, not
    // browser-login). codebuddy-china also uses static API keys (no login).
    const loginProviders = config.providers.filter(
      (p) => p !== "byok" && p !== "codebuddy-china" && p !== "youmind",
    );
    const items: BulkAddItem[] = credentials.map((c) => ({
      ...c,
      providers: loginProviders,
    }));
    return this.bulkAdd(items);
  }

  /**
   * Get queue status
   */
  getStatus() {
    return {
      queued: this.queue.length,
      active: this.activeJobs,
      processing: this.processing,
      totalProcessed: this.totalProcessed,
      totalSuccess: this.totalSuccess,
      totalFailed: this.totalFailed,
      retrying: this.retryTimers.size,
      activeAccountIds: Array.from(this.activeAccountIds),
      queuedAccountIds: this.queue.map((item) => item.accountId),
    };
  }

  /**
   * Clear the queue
   */
  clear(): void {
    this.queue = [];
    this.clearGeneration++;
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    // Phase 2: terminate the in-flight batch_login.py process (and its login.py
    // children via pterminate) so a clear actually stops the work. The stale
    // generation guards runBatch/handleBatchEvent from applying more results.
    if (this.batchProc) {
      const pid = this.batchProc.pid;
      if (pid) {
        // Kill the whole process group first (negative PID), then the parent.
        try { Bun.spawnSync(["pterminate", "-9", "-P", String(pid)]); } catch {}
        try { process.kill(-pid, "SIGTERM"); } catch {}
        try { process.kill(pid, "SIGTERM"); } catch {}
      }
      try { this.batchProc.kill("SIGTERM"); } catch {}
      this.batchProc = null;
    }
    this.activeAccountIds.clear();
    this.activeJobs = 0;
    this.processing = false;
    // Mark all automation browser sessions as done so BotLogs stops polling.
    for (const s of listSessions()) {
      if (s.sessionId.startsWith("batch-")) {
        s.phase = "complete";
        s.terminal = true;
        clearChallenge(s.sessionId);
      }
    }
    broadcast({ type: "queue_cleared", data: {} });
  }

  /**
   * Set concurrency level
   */
  setConcurrency(n: number): void {
    this.concurrency = Math.max(1, Math.min(n, 10));
  }

  setMaxRetries(n: number): void {
    this.maxRetries = Math.max(1, Math.min(Math.floor(n), 5));
  }

  private async process(): Promise<void> {
    if (this.processing) return;
    if (this.queue.length === 0) return;
    this.processing = true;

    // Drain the current queue into one batch. The Python batch_login.py runner
    // is now the concurrency authority (Phase 2): it spawns N workers, handles
    // retry+backoff and the not_eligible halt, and streams per-account result
    // events. TS maps each result to applyProviderResult / markLoginFailed
    // (the same logic loginAccount uses on the direct path) — the per-provider
    // DB/broadcast/VCC/post-processing is NOT ported to Python.
    const generation = this.clearGeneration;
    const batchItems = this.queue.splice(0);
    const options = batchItems[0];
    const headless = options?.headless;
    const browserEngine = options?.browserEngine;

    // Resolve the full account rows + decrypted passwords for the manifest.
    // Skip any that vanished from the DB between enqueue and run.
    const manifest: Array<{ accountId: number; email: string; password: string; provider: string }> = [];
    const accountRows = new Map<number, Account>();
    for (const item of batchItems) {
      if (item.generation !== this.clearGeneration) continue;
      const [account] = await db.select().from(accounts).where(eq(accounts.id, item.accountId));
      if (!account) continue;
      accountRows.set(account.id, account);
      this.activeAccountIds.add(account.id);
      manifest.push({
        accountId: account.id,
        email: account.email,
        password: decrypt(account.password),
        provider: account.provider,
      });
    }
    this.activeJobs = manifest.length;

    if (manifest.length === 0) {
      this.processing = false;
      this.finishBatchIfDone(generation);
      return;
    }

    broadcast({
      type: "queue_processing",
      data: {
        accountId: manifest[0]!.accountId,
        email: manifest[0]!.email,
        provider: manifest[0]!.provider,
        attempt: 1,
        remaining: 0,
        message: `Starting batch of ${manifest.length} account(s) at concurrency ${this.concurrency}`,
      },
    });

    // Antigravity uses the per-account frame-streaming path (one isolated
    // nodriver browser per account, like ennowxai's per-account kiro_login.py).
    // Other providers keep the batch_login.py multi-worker path.
    const allAntigravity = manifest.every((m) => m.provider === "antigravity");
    if (allAntigravity) {
      await this.runAntigravityBatch(manifest, generation, accountRows);
      return;
    }

    await this.runBatch(manifest, { headless, browserEngine }, generation, accountRows);
  }

  /**
   * Antigravity batch: spawn ONE antigravity_manual_login.py per account, up to
   * `this.concurrency` at a time. Each spawn = one isolated nodriver browser that
   * streams frames continuously (the Browser Logs page shows N live previews).
   * Mirrors ennowxai's model where the backend spawns kiro_login.py per account
   * and manages concurrency. runAntigravityManualLogin is self-contained: it
   * registers its own session, bridges events, handles captcha, and applies the
   * DB result. We just throttle how many run at once.
   *
   * When concurrency > 1, browsers run headless to avoid opening multiple
   * visible windows and to allow the dashboard frame viewer to handle all
   * sessions cleanly. CAPTCHA challenges still round-trip through the dashboard.
   */
  private async runAntigravityBatch(
    manifest: Array<{ accountId: number; email: string; password: string; provider: string }>,
    generation: number,
    accountRows: Map<number, Account>,
  ): Promise<void> {
    const limit = Math.max(1, Math.min(this.concurrency || 2, manifest.length));
    const headless = limit > 1;  // Auto-headless when running concurrent browsers
    let nextIndex = 0;
    let active = 0;
    let done = 0;
    const total = manifest.length;

    const log = (m: string) => console.log(`[ag-batch] ${m}`);

    log(`starting accounts=${total} concurrency=${limit} headless=${headless} frameRelay=true`);

    await new Promise<void>((resolveAll) => {
      const startNext = () => {
        // Stop if a newer batch generation superseded this one.
        if (generation !== this.batchGeneration) {
          if (active === 0) resolveAll();
          return;
        }
        while (active < limit && nextIndex < total) {
          const item = manifest[nextIndex++];
          const account = accountRows.get(item.accountId);
          if (!account) {
            done++;
            continue;
          }
          active++;
          const idx = done;
          log(`worker ${idx + 1}/${total} start email=${item.email}`);

          // Fire-and-forget per account; resolve slot on completion.
          // Wave 3 migration: loginAccount() now routes antigravity through the
          // TS+Camoufox stealth engine (googleAutomation.ts), replacing the
          // nodriver-based antigravity_manual_login.py subprocess. Manual/CAPTCHA
          // challenges surface as a `manual` result and round-trip via the
          // dashboard session layer.
          loginAccount(account, { headless })
            .catch((err) => {
              log(`worker ${idx + 1}/${total} crash email=${item.email} error=${err?.message || err}`);
            })
            .finally(() => {
              active--;
              done++;
              log(`worker ${idx + 1}/${total} done email=${item.email} (${done}/${total})`);
              broadcast({
                type: "queue_processing",
                data: {
                  accountId: item.accountId,
                  email: item.email,
                  provider: "antigravity",
                  attempt: 1,
                  remaining: Math.max(0, total - done),
                  message: `Account ${done}/${total} finished`,
                },
              });
              if (done >= total) {
                resolveAll();
              } else {
                startNext();
              }
            });
        }
      };
      startNext();
    });

    log(`batch complete done=${done}/${total}`);
    this.processing = false;
    this.finishBatchIfDone(generation);
  }

  /**
   * Run a batch of logins through the native TS+Camoufox automation layer
   * (Wave 3 migration — replaces the batch_login.py subprocess). Fans out up to
   * `concurrency` loginAccount() calls in parallel, mapping each result to
   * applyProviderResult / markLoginFailed, exactly as the old Python event
   * stream did. Retry/backoff is handled inside loginAccount's provider path.
   */
  private async runBatch(
    manifest: Array<{ accountId: number; email: string; password: string; provider: string }>,
    options: { headless?: boolean; browserEngine?: string },
    generation: number,
    accountRows: Map<number, Account>,
  ): Promise<void> {
    this.batchGeneration = generation;
    console.log(`[batch] native TS+Camoufox batch started accounts=${manifest.length} concurrency=${this.concurrency}`);
    const seenResultIds = new Set<number>();

    // Concurrency-limited worker pool over the manifest.
    const queue = [...manifest];
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(this.concurrency, manifest.length);
    const runOne = async (acc: { accountId: number; provider: string }) => {
      if (generation !== this.clearGeneration) return; // stale batch
      const account = accountRows.get(acc.accountId);
      if (!account) return;
      try {
        const result = await loginAccount(account, { headless: options.headless ?? config.headless });
        seenResultIds.add(acc.accountId);
        if (!result.success) {
          this.totalFailed++;
        }
        this.totalProcessed++;
        this.activeAccountIds.delete(acc.accountId);
      } catch (err: any) {
        await markLoginFailed(account, acc.provider, err?.message || "login threw");
        seenResultIds.add(acc.accountId);
        this.totalProcessed++;
        this.totalFailed++;
        this.activeAccountIds.delete(acc.accountId);
      }
    };
    for (let w = 0; w < workerCount; w++) {
      workers.push((async () => {
        while (queue.length && generation === this.clearGeneration) {
          const acc = queue.shift();
          if (acc) await runOne(acc);
        }
      })());
    }
    await Promise.all(workers);

    // Any account that never produced a result → fail (safety net).
    for (const acc of manifest) {
      if (generation !== this.clearGeneration) break;
      if (!seenResultIds.has(acc.accountId)) {
        const account = accountRows.get(acc.accountId);
        if (account) {
          await markLoginFailed(account, account.provider, "batch ended without a result for this account");
        }
        this.totalProcessed++;
        this.totalFailed++;
        this.activeAccountIds.delete(acc.accountId);
      }
    }
    this.activeJobs = 0;
    this.processing = false;

    if (generation === this.clearGeneration && this.queue.length > 0) {
      this.process();
    } else {
      this.finishBatchIfDone(generation);
    }
  }

  private handleBatchEvent(
    event: any,
    accountRows: Map<number, Account>,
    seenResultIds: Set<number>,
    generation: number,
  ): void {
    if (event.type === "progress") {
      // Surface worker progress as a queue_processing broadcast so the
      // dashboard live-log stays populated (mirrors old per-account emitProgressLog).
      const account = accountRows.get(event.accountId);
      if (account) {
        broadcast({
          type: "queue_processing",
          data: {
            accountId: event.accountId,
            email: account.email,
            provider: account.provider || event.provider,
            attempt: event.attempt || 1,
            remaining: 0,
            step: event.step,
            message: event.message,
            worker: event.worker,
          },
        });
      }
      // Also append to the per-session step timeline (richer Browser Logs view).
      appendStep(
        `batch-${event.accountId}`,
        event.step || "progress",
        event.message || "",
        event.provider || (account ? account.provider : "") || "",
      );
      return;
    }
    // ── frame relay: route JPEG frames + phase + captcha to the in-app
    // Browser Logs live viewer (same registry the manual-login path uses).
    if (event.type === "frame") {
      // Debug: log first frame so we know the relay is working.
      if (!this._firstFrameSeen) { this._firstFrameSeen = true; console.log(`[batch] first frame received for account ${event.accountId}`); }
      const sid = `batch-${event.accountId}`;
      if (!getSession(sid)) {
        registerSession({
          sessionId: sid,
          accountId: Number(event.accountId) || 0,
          email: accountRows.get(Number(event.accountId))?.email || "",
          provider: event.provider || "automation",
          phase: "automation",
          lastMessage: "",
          lastFrame: "",
          lastFrameFormat: "jpeg",
          lastFrameTime: Date.now(),
          steps: [],
          challenge: null,
          terminal: false,
          proc: this.batchProc ?? null,
          stdinWriter: this.batchStdinWriter,
          cancelSignalFile: "",
          startedAt: Date.now(),
        });
      }
      // Store RAW base64 (no data: prefix) — lastFrame's contract is "base64
      // JPEG (no data: prefix)". The /frames SSE layer sends it as the
      // `base64` field, and the client adds the data:image/...;base64, prefix,
      // matching the ennowxai frame contract exactly.
      updateFrame(sid, event.base64 || "", event.format || "jpeg");
      return;
    }
    if (event.type === "phase") {
      const sid = `batch-${event.accountId}`;
      updatePhase(sid, event.step || "", event.message || "");
      return;
    }
    if (event.type === "manual_challenge") {
      const sid = `batch-${event.accountId}`;
      updateChallenge(sid, {
        image_base64: event.image_base64 || "",
        image_format: "jpeg",
        prompt: event.message || "",
        seq: 1,
      });
      return;
    }
    if (event.type === "upgrade_card_result") {
      // Live VCC card-status update (declined cards fail fast so the next
      // account won't reuse them) — mirrors loginAccount's stdout handler.
      const { card_last4, card_status } = event;
      if (card_last4 && card_status && card_status !== "success") {
        const status = card_status === "declined" ? "declined" as const : "error" as const;
        void handleCardResult(event.accountId, card_last4, status);
      }
      return;
    }
    if (event.type === "batch_halted") {
      // Global not_eligible — clear remaining queue (mirrors old processItem).
      this.queue = [];
      broadcast({ type: "queue_cleared", data: { reason: event.reason || "not_eligible" } });
      return;
    }
    if (event.type === "result") {
      const accountId = event.accountId;
      if (accountId == null || seenResultIds.has(accountId)) return;
      seenResultIds.add(accountId);
      const account = accountRows.get(accountId);
      if (!account) return;
      this.activeAccountIds.delete(accountId);
      this.activeJobs = Math.max(0, this.activeJobs - 1);
      this.totalProcessed++;

      // Fire-and-forget the DB/broadcast mapping. applyProviderResult/markLoginFailed
      // are the exact logic loginAccount uses on the direct path.
      void (async () => {
        try {
          if (event.success) {
            await applyProviderResult(
              account,
              account.provider,
              decrypt(account.password),
              {
                success: true,
                provider: account.provider,
                credentials: event.credentials || {},
                quota: event.quota || {},
              },
            );
            this.totalSuccess++;
          } else {
            await markLoginFailed(account, account.provider, event.error || "Login failed");
            this.totalFailed++;
            // noRetry results that aren't halt conditions are terminal; the
            // not_eligible halt is already handled by batch_halted above.
          }
        } catch {
          this.totalFailed++;
        }
      })();
      return;
    }
  }

  private finishBatchIfDone(generation: number): void {
    if (generation !== this.clearGeneration) return;
    if (this.activeJobs === 0 && this.queue.length === 0 && this.retryTimers.size === 0) {
      this.processing = false;
      broadcast({
        type: "queue_complete",
        data: {
          totalProcessed: this.totalProcessed,
          totalSuccess: this.totalSuccess,
          totalFailed: this.totalFailed,
        },
      });
    }
  }

  private hasPendingOrActive(accountId: number): boolean {
    return this.queue.some((item) => item.accountId === accountId)
      || this.activeAccountIds.has(accountId)
      || this.retryTimers.has(accountId);
  }

  private async processItem(_item: QueueItem): Promise<void> {
    // Phase 2: per-account work moved to the Python batch runner (runBatch).
    // Retained as a no-op so any external caller still compiles; the queue
    // now drives batches via process() → runBatch().
    void _item;
  }
}

export const loginQueue = new LoginQueue();
