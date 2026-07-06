import { lazy, Suspense, useState, useEffect } from "react";
import { Routes, Route } from "react-router-dom";
import Layout from "./components/layout/Layout";
import Login from "./pages/Login";
import { AntigravityChallengeModal } from "./components/auth/AntigravityChallengeModal";
import { isAuthenticated, validateApiKey, logout } from "./lib/api";

const Dashboard = lazy(() => import("./pages/Dashboard"));
const Accounts = lazy(() => import("./pages/Accounts"));
const AccountList = lazy(() => import("./pages/AccountList"));
const ByokAccountList = lazy(() => import("./pages/ByokAccountList"));
const Models = lazy(() => import("./pages/Models"));
const ApiKey = lazy(() => import("./pages/ApiKey"));
const Requests = lazy(() => import("./pages/Requests"));
const Usage = lazy(() => import("./pages/Usage"));
const Settings = lazy(() => import("./pages/Settings"));
const BotLogs = lazy(() => import("./pages/BotLogs"));
const Automation = lazy(() => import("./pages/Automation"));
const VccPool = lazy(() => import("./pages/VccPool"));
const ProxyPool = lazy(() => import("./pages/ProxyPool"));
const ImageStudio = lazy(() => import("./pages/ImageStudio"));
const Chat = lazy(() => import("./pages/Chat"));
const Analytics = lazy(() => import("./pages/Analytics"));
const FilterRules = lazy(() => import("./pages/FilterRules"));
const Integration = lazy(() => import("./pages/Integration"));
const CodexOAuthCallback = lazy(() => import("./pages/CodexOAuthCallback"));
const Combos = lazy(() => import("./pages/Combos"));
const Translator = lazy(() => import("./pages/Translator"));
const MediaProviders = lazy(() => import("./pages/MediaProviders"));
const LiveConsole = lazy(() => import("./pages/LiveConsole"));
const Skills = lazy(() => import("./pages/Skills"));

function RouteFallback() {
  return <div className="flex h-64 items-center justify-center text-sm text-[var(--muted-foreground)]">Loading...</div>;
}

export default function App() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    async function check() {
      if (!isAuthenticated()) {
        setAuthed(false);
        return;
      }
      const key = localStorage.getItem("api_key")!;
      const valid = await validateApiKey(key);
      if (!valid) {
        logout();
        setAuthed(false);
      } else {
        setAuthed(true);
      }
    }
    check();
  }, []);

  function handleLogin() {
    setAuthed(true);
  }

  function handleLogout() {
    logout();
    setAuthed(false);
  }

  if (authed === null) {
    return <div className="flex h-screen items-center justify-center text-sm text-[var(--muted-foreground)]">Loading...</div>;
  }

  if (!authed) {
    return <Login onLogin={handleLogin} />;
  }

  return (
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
          <Route path="/usage" element={<Usage />} />
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
          <Route path="/oauth/codex/callback" element={<CodexOAuthCallback />} />
        </Route>
      </Routes>
    </Suspense>
  );
}
