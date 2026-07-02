# cli
- On Windows, `Bun.spawn(["bun", ...])` fails with ENOENT because libuv's `uv_spawn` doesn't inherit shell PATH like `bun.exe` needs `C:\Users\HP\.bun\bin\bun.exe` absolute path or explicit `PATH` override in the `env` object. Confidence: 0.70
- `new URL("..", import.meta.url).pathname` on Windows returns paths like `/D:/proxy/` (leading slash + forward slashes) which `Bun.spawn` rejects as `cwd` — must strip leading `/` and replace `/` with `\\` for Windows. Confidence: 0.65
- In PowerShell `Start-Process`, `-RedirectStandardOutput` and `-RedirectStandardError` cannot redirect to the same file path; use separate files for stdout and stderr. Confidence: 0.60

# typescript
- Dashboard `resolveApiBase()` and `getWsBase()` must not blindly subtract 1 from `window.location.port` — when the backend serves the dashboard (same origin), `port - 1` computes the wrong port. Fix: check if port matches known dashboard port (`1931`) and use backend port, else fall back to same origin. Confidence: 0.65

# database
- Fresh SQLite project with drizzle needs `bunx drizzle-kit generate` first to create migration SQL from schema files, then `bun run migrate` or `drizzle-kit push` — the initial DB has no tables so direct migration fails with "no such table" errors if migrations were never generated. Confidence: 0.60
