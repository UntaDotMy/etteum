import { db } from "../db/index";
import { accounts } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { loginAccount, loginAllProviders, applyProviderResult, markLoginFailed } from "./runner";
import { registerSession, getSession, listSessions, updateFrame, updatePhase, updateChallenge, clearChallenge, deleteSession } from "./browserSession";
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
  async queueAllPending(options: { headless?: boolean; browserEngine?: string; concurrency?: number } = {}): Promise<number> {
    if (options.concurrency !== undefined) this.setConcurrency(options.concurrency);

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
  async bulkAdd(items: BulkAddItem[], options: { headless?: boolean; concurrency?: number; browserEngine?: string } = {}): Promise<{ created: number; queued: number }> {
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

    await this.runBatch(manifest, { headless, browserEngine }, generation, accountRows);
  }

  /**
   * Spawn batch_login.py, write the manifest to its stdin, stream line-JSON
   * events, and map each per-account result to applyProviderResult /
   * markLoginFailed. Retry, backoff, and the not_eligible halt live in Python.
   */
  private async runBatch(
    manifest: Array<{ accountId: number; email: string; password: string; provider: string }>,
    options: { headless?: boolean; browserEngine?: string },
    generation: number,
    accountRows: Map<number, Account>,
  ): Promise<void> {
    const { getNextProxy } = await import("../services/proxy-pool");
    const proxyUrl = (await getNextProxy("auth"))?.url || config.proxyUrl || "";

    const batchScript = config.authScriptPath.replace(/login\.py$/, "batch_login.py");
    const proc = Bun.spawn(
      [config.pythonPath, batchScript, "--concurrency", String(this.concurrency), "--max-retries", String(this.maxRetries)],
      {
        stdout: "pipe",
        stderr: "pipe",
        stdin: "pipe",
        env: {
          ...process.env,
          PYTHONUNBUFFERED: "1",
          BATCHER_PROXY_URL: proxyUrl,
          HTTP_PROXY: proxyUrl,
          HTTPS_PROXY: proxyUrl,
          ...(options.browserEngine ? { BATCHER_BROWSER_ENGINE: options.browserEngine } : {}),
          BATCHER_FRAME_RELAY: "true",
        },
        cwd: config.authScriptCwd,
      },
    );
    this.batchProc = proc;
    this.batchGeneration = generation;
    this.batchStdinWriter = {
      write: (chunk: Uint8Array) => { try { proc.stdin!.write(chunk); } catch {} return Promise.resolve(); },
      close: () => { try { proc.stdin!.end(); } catch {} return Promise.resolve(); },
    };

    // Write the manifest: one header line, one line per account, then eof.
    // Bun's FileSink (stdin:"pipe") exposes write()/end() directly — not the
    // WritableStream writer API.
    const stdin = proc.stdin!;
    const enc = new TextEncoder();
    const header: any = { type: "manifest", concurrency: this.concurrency, headless: options.headless ?? config.headless, maxRetries: this.maxRetries };
    if (options.browserEngine) header.browserEngine = options.browserEngine;
    if (proxyUrl) header.proxyUrl = proxyUrl;
    stdin.write(enc.encode(JSON.stringify(header) + "\n"));
    for (const acc of manifest) {
      stdin.write(enc.encode(JSON.stringify({ type: "account", ...acc }) + "\n"));
    }
    // stdin stays open so captcha answers / cancel can flow back to the workers.

    // Stream stdout line-by-line and map events.
    const decoder = new TextDecoder();
    let buffer = "";
    const reader = proc.stdout.getReader();
    const seenResultIds = new Set<number>();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          let event: any;
          try { event = JSON.parse(line); } catch { continue; }
          if (generation !== this.clearGeneration) continue; // stale batch
          this.handleBatchEvent(event, accountRows, seenResultIds, generation);
        }
      }
    } catch {
      // reader closed — fall through to finalize
    }

    await proc.exited;
    this.batchProc = null;
    this.batchStdinWriter = null;
    try { stdin.end(); } catch {}

    // Any account that never produced a result (e.g. process crashed) → fail.
    for (const acc of manifest) {
      if (generation !== this.clearGeneration) break;
      if (!seenResultIds.has(acc.accountId)) {
        const account = accountRows.get(acc.accountId);
        if (account) {
          await markLoginFailed(account, account.provider, "batch runner ended without a result for this account");
        }
        this.totalProcessed++;
        this.totalFailed++;
        this.activeAccountIds.delete(acc.accountId);
      }
    }
    this.activeJobs = 0;
    this.processing = false;

    // If new accounts were enqueued during the batch, process them; else done.
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
      return;
    }
    // ── frame relay: route JPEG frames + phase + captcha to the in-app
    // Browser Logs live viewer (same registry the manual-login path uses).
    if (event.type === "frame") {
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
          challenge: null,
          terminal: false,
          proc: this.batchProc ?? null,
          stdinWriter: this.batchStdinWriter,
          cancelSignalFile: "",
          startedAt: Date.now(),
        });
      }
      updateFrame(sid, `data:image/jpeg;base64,${event.base64}`, event.format || "jpeg");
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
