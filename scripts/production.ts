#!/usr/bin/env bun
/**
 * Production start script.
 *
 * 1. Builds dashboard (if needed)
 * 2. Starts backend (API + proxy on PORT)
 * 3. Starts dashboard static server (on DASHBOARD_PORT)
 *
 * Both are lightweight Bun processes. No Vite dev server.
 *
 * Usage:
 *   bun run production
 *   bun run scripts/production.ts
 *   bun run scripts/production.ts --skip-build
 */

const root = (() => {
  const urlPath = new URL("..", import.meta.url).pathname;
  if (process.platform === "win32" && urlPath.startsWith("/")) {
    return urlPath.slice(1).replace(/\//g, "\\");
  }
  return urlPath;
})();
const dashboardDir = `${root}/dashboard`;
const dashboardDist = `${dashboardDir}/dist/index.html`;
const skipBuild = process.argv.includes("--skip-build");

const isWindows = process.platform === "win32";
function resolveBunBin(): string | null {
  if (process.env.BUN_EXECUTABLE_PATH) return process.env.BUN_EXECUTABLE_PATH;
  const candidates = isWindows
    ? [`${process.env.USERPROFILE || ""}\\.bun\\bin\\bun.exe`]
    : [`${process.env.HOME || ""}/.bun/bin/bun`];
  for (const p of candidates) {
    if (p && Bun.file(p).size > 0) return p;
  }
  return null;
}
const bunExe = resolveBunBin();
const bunCmd = bunExe || (isWindows ? "bun.exe" : "bun");

const port = process.env.PORT || "1930";
const dashboardPort = process.env.DASHBOARD_PORT || "1931";
const sharePort = process.env.SHARE_PORT || "80";

async function buildDashboard() {
  const distExists = await Bun.file(dashboardDist).exists();

  if (skipBuild && distExists) {
    console.log("[production] Skipping dashboard build (--skip-build)");
    return;
  }

  if (!skipBuild || !distExists) {
    console.log("[production] Building dashboard...");
    const proc = Bun.spawn([bunCmd, "run", "build"], {
      cwd: dashboardDir,
      stdout: "inherit",
      stderr: "inherit",
      env: {
        ...process.env,
        VITE_BACKEND_PORT: port,
      },
    });
    const code = await proc.exited;
    if (code !== 0) {
      console.error("[production] Dashboard build failed!");
      process.exit(1);
    }
    console.log("[production] Dashboard built successfully.\n");
  }
}

await buildDashboard();

console.log(`╔══════════════════════════════════════╗`);
console.log(`║   Pool Proxy — Production Mode       ║`);
console.log(`╠══════════════════════════════════════╣`);
console.log(`║  Backend:   http://localhost:${port}    ║`);
console.log(`║  Dashboard: http://localhost:${dashboardPort}    ║`);
console.log(`╚══════════════════════════════════════╝\n`);

// Start backend
const backend = Bun.spawn([bunCmd, "src/index.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    PORT: port,
    NODE_ENV: "production",
  },
});

// Start dashboard static server
const dashboard = Bun.spawn([bunCmd, "run", "scripts/serve-dashboard.ts"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
  env: {
    ...process.env,
    DASHBOARD_PORT: dashboardPort,
    NODE_ENV: "production",
  },
});

// Start the friend-key status server (dudul-style card). Failure to bind (e.g.
// port 80 needs privileges) is logged but does NOT take down the proxy/dashboard.
let share: ReturnType<typeof Bun.spawn> | null = null;
if (process.env.SHARE_ENABLED !== "0") {
  share = Bun.spawn([bunCmd, "run", "scripts/serve-share.ts"], {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
    env: {
      ...process.env,
      SHARE_PORT: sharePort,
      PORT: port,
      NODE_ENV: "production",
    },
  });
  share.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`[production] Share server exited with code ${code} (port ${sharePort}). Continuing without it.`);
    }
  });
}

let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  backend.kill();
  dashboard.kill();
  share?.kill();
  setTimeout(() => process.exit(code), 300).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// If either process dies, shut down both
backend.exited.then((code) => {
  if (!shuttingDown) {
    console.error(`[production] Backend exited with code ${code}`);
    shutdown(code || 1);
  }
});

dashboard.exited.then((code) => {
  if (!shuttingDown) {
    console.error(`[production] Dashboard exited with code ${code}`);
    shutdown(code || 1);
  }
});

await new Promise(() => {});
