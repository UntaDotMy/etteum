import { lazy, Suspense, useState, useEffect, type ComponentType } from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/layout/Layout";
import Login from "./pages/Login";
import { AntigravityChallengeModal } from "./components/auth/AntigravityChallengeModal";
import { validateApiKey, logout, getDashboardAuthStatus } from "./lib/api";
import { WebSocketProvider } from "./hooks/useWebSocket";

/** Lazy import with one reload retry when a deploy invalidated chunk hashes. */
function lazyPage<T extends ComponentType<unknown>>(
  factory: () => Promise<{ default: T }>,
) {
  return lazy(async () => {
    try {
      return await factory();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err ?? "");
      const stale =
        /Failed to fetch dynamically imported module|Loading chunk|Importing a module script failed|text\/html/i.test(
          msg,
        );
      if (stale) {
        try {
          const key = "etteum-lazy-chunk-reload";
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, "1");
            window.location.reload();
            return await new Promise<never>(() => {});
          }
          sessionStorage.removeItem(key);
        } catch {
          /* ignore */
        }
      }
      throw err;
    }
  });
}

const Dashboard = lazyPage(() => import("./pages/Dashboard"));
const Accounts = lazyPage(() => import("./pages/Accounts"));
const AccountList = lazyPage(() => import("./pages/AccountList"));
const ByokAccountList = lazyPage(() => import("./pages/ByokAccountList"));
const Models = lazyPage(() => import("./pages/Models"));
const ApiKey = lazyPage(() => import("./pages/ApiKey"));
const Requests = lazyPage(() => import("./pages/Requests"));
const Settings = lazyPage(() => import("./pages/Settings"));
const BotLogs = lazyPage(() => import("./pages/BotLogs"));
const Automation = lazyPage(() => import("./pages/Automation"));
const VccPool = lazyPage(() => import("./pages/VccPool"));
const ProxyPool = lazyPage(() => import("./pages/ProxyPool"));
const ImageStudio = lazyPage(() => import("./pages/ImageStudio"));
const Chat = lazyPage(() => import("./pages/Chat"));
const Analytics = lazyPage(() => import("./pages/Analytics"));
const FilterRules = lazyPage(() => import("./pages/FilterRules"));
const Integration = lazyPage(() => import("./pages/Integration"));
const CodexOAuthCallback = lazyPage(() => import("./pages/CodexOAuthCallback"));
const Combos = lazyPage(() => import("./pages/Combos"));
const Translator = lazyPage(() => import("./pages/Translator"));
const MediaProviders = lazyPage(() => import("./pages/MediaProviders"));
const LiveConsole = lazyPage(() => import("./pages/LiveConsole"));
const Skills = lazyPage(() => import("./pages/Skills"));
const SecurityProfile = lazyPage(() => import("./pages/SecurityProfile"));
const Mitm = lazyPage(() => import("./pages/Mitm"));

function RouteFallback() {
  return <div className="flex h-64 items-center justify-center text-sm text-[var(--muted-foreground)]">Loading...</div>;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    async function check() {
      // 1) Valid dashboard JWT session cookie?
      const session = await getDashboardAuthStatus();
      if (session?.authenticated) {
        localStorage.setItem("dashboard_session", "1");
        setAuthed(true);
        return;
      }

      // 2) API-key mode (localStorage).
      const key = localStorage.getItem("api_key");
      if (key) {
        const valid = await validateApiKey(key);
        if (valid) {
          setAuthed(true);
          return;
        }
        localStorage.removeItem("api_key");
      }

      localStorage.removeItem("dashboard_session");
      setAuthed(false);
    }
    check();
  }, []);

  function handleLogin() {
    setAuthed(true);
  }

  async function handleLogout() {
    await logout();
    setAuthed(false);
  }

  if (authed === null) {
    return <div className="flex h-screen items-center justify-center text-sm text-[var(--muted-foreground)]">Loading...</div>;
  }

  if (!authed) {
    return <Login onLogin={handleLogin} />;
  }

  // Mount WS only after auth so the session cookie exists before the first
  // upgrade (password login clears localStorage api_key on purpose).
  return (
    <WebSocketProvider>
    <Suspense fallback={<RouteFallback />}>
      <AntigravityChallengeModal />
      <Routes>
        <Route element={<Layout onLogout={handleLogout} />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/accounts" element={<Accounts />} />
          <Route path="/accounts/byok/:prefix" element={<ByokAccountList />} />
          <Route path="/accounts/:provider" element={<AccountList />} />
          <Route path="/automation" element={<Automation />} />
          <Route path="/models" element={<Models />} />
          <Route path="/api-key" element={<ApiKey />} />
          <Route path="/requests" element={<Requests />} />
          <Route path="/bot-logs" element={<BotLogs />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/vcc-pool" element={<VccPool />} />
          <Route path="/proxy-pool" element={<ProxyPool />} />
          <Route path="/filter-rules" element={<FilterRules />} />
          <Route path="/integration" element={<Integration />} />
          <Route path="/image-studio" element={<ImageStudio />} />
          <Route path="/chat" element={<Chat />} />
          <Route path="/analytics" element={<Analytics />} />
          <Route path="/combos" element={<Combos />} />
          <Route path="/translator" element={<Translator />} />
          <Route path="/media" element={<MediaProviders />} />
          <Route path="/console" element={<LiveConsole />} />
          <Route path="/skills" element={<Skills />} />
          <Route path="/security" element={<SecurityProfile />} />
          <Route path="/mitm" element={<Mitm />} />
          <Route path="/oauth/codex/callback" element={<CodexOAuthCallback />} />
        </Route>
      </Routes>
    </Suspense>
    </WebSocketProvider>
  );
}
