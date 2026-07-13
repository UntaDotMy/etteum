import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { ThemeProvider } from "./hooks/useTheme";
import { WebSocketProvider } from "./hooks/useWebSocket";
import "./index.css";

/**
 * After a deploy/rebuild, Vite content hashes change (e.g. AccountList-T9fan1ya.js
 * → AccountList-CokZvzEw.js). A tab still holding the old graph fails dynamic
 * import; the server used to SPA-fallback HTML for the missing file → MIME error.
 * One hard reload picks up the new index.html + hashes.
 */
const CHUNK_RELOAD_KEY = "etteum-chunk-reload";

function isStaleChunkError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? "");
  return /Failed to fetch dynamically imported module|Loading chunk [\d]+ failed|Importing a module script failed|Expected a JavaScript-or-Wasm module script|MIME type of ["']text\/html["']/i.test(
    msg,
  );
}

function recoverStaleChunkOnce(err: unknown): boolean {
  if (!isStaleChunkError(err)) return false;
  try {
    if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) return false;
    sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
  } catch {
    /* private mode */
  }
  window.location.reload();
  return true;
}

window.addEventListener("unhandledrejection", (ev) => {
  if (recoverStaleChunkOnce(ev.reason)) ev.preventDefault();
});
window.addEventListener("error", (ev) => {
  if (recoverStaleChunkOnce(ev.error || ev.message)) ev.preventDefault();
});
// Clear the one-shot flag after a healthy boot so the next deploy can recover again.
window.setTimeout(() => {
  try {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    /* ignore */
  }
}, 15_000);

ReactDOM.createRoot(document.getElementById("root")!).render(
  <ThemeProvider>
    <WebSocketProvider>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </WebSocketProvider>
  </ThemeProvider>
);
