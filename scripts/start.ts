const root = (() => {
  const urlPath = new URL("..", import.meta.url).pathname;
  if (process.platform === "win32" && urlPath.startsWith("/")) {
    return urlPath.slice(1).replace(/\//g, "\\");
  }
  return urlPath;
})();
const port = process.env.PORT || "1930";
const dashboardPort = process.env.DASHBOARD_PORT || "1931";

const isWindows = process.platform === "win32";

function resolveBunBin(): string | null {
  if (process.env.BUN_EXECUTABLE_PATH) return process.env.BUN_EXECUTABLE_PATH;
  const candidates = isWindows
    ? [
        `${process.env.USERPROFILE || ""}\\.bun\\bin\\bun.exe`,
      ]
    : [`${process.env.HOME || ""}/.bun/bin/bun`];
  for (const p of candidates) {
    if (p && Bun.file(p).size > 0) return p;
  }
  return null;
}

const bunExe = resolveBunBin();
const bunCmd = bunExe || (isWindows ? "bun.exe" : "bun");
const bunxCmd = bunExe ? bunExe.replace(/bun(\.exe)?$/, "bunx$1") : (isWindows ? "bunx.cmd" : "bunx");

function spawnProcess(name: string, command: string[], cwd = root) {
  const proc = Bun.spawn(command, {
    cwd,
    env: {
      ...process.env,
      PORT: port,
      DASHBOARD_PORT: dashboardPort,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  const prefix = `[${name}]`;

  void streamWithPrefix(proc.stdout, prefix);
  void streamWithPrefix(proc.stderr, prefix);

  proc.exited.then((code) => {
    if (!shuttingDown) {
      console.error(`${prefix} exited with code ${code}`);
      shutdown(code || 1);
    }
  });

  return proc;
}

async function streamWithPrefix(stream: ReadableStream<Uint8Array>, prefix: string) {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.trim().length > 0) console.log(`${prefix} ${line}`);
    }
  }

  if (buffer.trim().length > 0) console.log(`${prefix} ${buffer}`);
}

let shuttingDown = false;
const children: ReturnType<typeof spawnProcess>[] = [];

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) child.kill();
  setTimeout(() => process.exit(code), 200).unref();
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

console.log(`\nPool Proxy starting...`);
console.log(`Backend:   http://localhost:${port}`);
console.log(`Dashboard: http://localhost:${dashboardPort}`);
const apiKey = process.env.API_KEY || "pool-proxy-secret-key";
const maskedKey = apiKey.length > 8 ? apiKey.slice(0, 4) + "***" + apiKey.slice(-4) : "***";
console.log(`API Key:   ${maskedKey}\n`);

children.push(spawnProcess("backend", [bunCmd, "src/index.ts"]));
children.push(
  spawnProcess("dashboard", [
    bunxCmd,
    "vite",
    "--host",
    "0.0.0.0",
    "--port",
    dashboardPort,
  ], `${root}/dashboard`)
);

await new Promise(() => {});
