import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import StartAutomationModal from "@/components/automation/StartAutomationModal";
import { importAccounts } from "@/lib/api";
import { useWsEvent, useWsStatus } from "@/hooks/useWebSocket";
import {
  ExternalLink,
  Zap,
  Bot,
  Globe,
  Palette,
  Rocket,
  Monitor,
  ArrowRight,
  Radio,
  CheckCircle2,
  CircleDashed,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

interface ProviderConfig {
  value: string;
  label: string;
  subtitle: string;
  description: string;
  icon: LucideIcon;
  comingSoon?: boolean;
  engine: "camoufox" | "native" | "api";
}

const PROVIDERS: ProviderConfig[] = [
  {
    value: "kiro",
    label: "Kiro",
    subtitle: "Google SSO → OAuth tokens via Camoufox",
    description: "Stealth browser login. Frames and steps stream live into Browser Logs.",
    icon: Zap,
    engine: "camoufox",
  },
  {
    value: "codebuddy",
    label: "CodeBuddy",
    subtitle: "Google login → API key via Camoufox",
    description: "Landing + Google OAuth + region. Live preview on Browser Logs.",
    icon: Bot,
    engine: "camoufox",
  },
  {
    value: "canva",
    label: "Canva",
    subtitle: "Google OAuth popup via Camoufox",
    description: "Browser login with cookie capture. Connected to Browser Logs frames.",
    icon: Palette,
    engine: "camoufox",
  },
  {
    value: "qoder",
    label: "Qoder",
    subtitle: "Device flow + Google via Camoufox",
    description: "Device authorization with live progress and frame stream.",
    icon: Globe,
    engine: "camoufox",
  },
  {
    value: "antigravity",
    label: "Antigravity",
    subtitle: "Native Camoufox Google automation",
    description: "TS automation path with the same Browser Logs session registry.",
    icon: Rocket,
    engine: "native",
  },
  {
    value: "codebuddy-cn",
    label: "CodeBuddy CN",
    subtitle: "OTP + HTTP API (no browser)",
    description: "Warpize OTP registration — no live frame stream.",
    icon: Bot,
    engine: "api",
    comingSoon: true,
  },
];

type LiveEvent = {
  ts: number;
  provider: string;
  step: string;
  message: string;
  level: "info" | "error" | "success";
};

export default function Automation() {
  const navigate = useNavigate();
  const wsStatus = useWsStatus();
  const [modalProvider, setModalProvider] = useState<ProviderConfig | null>(null);
  const [live, setLive] = useState<LiveEvent[]>([]);

  useWsEvent("login_progress", (msg) => {
    const e = msg?.data ?? msg;
    if (!e) return;
    setLive((prev) =>
      [
        ...prev.slice(-39),
        {
          ts: Date.now(),
          provider: String(e.provider || ""),
          step: String(e.step || "progress"),
          message: String(e.message || ""),
          level: "info" as const,
        },
      ],
    );
  });
  useWsEvent("login_failed", (msg) => {
    const e = msg?.data ?? msg;
    if (!e) return;
    setLive((prev) =>
      [
        ...prev.slice(-39),
        {
          ts: Date.now(),
          provider: String(e.provider || ""),
          step: "failed",
          message: String(e.error || e.message || "login failed"),
          level: "error" as const,
        },
      ],
    );
  });
  useWsEvent("login_success", (msg) => {
    const e = msg?.data ?? msg;
    if (!e) return;
    setLive((prev) =>
      [
        ...prev.slice(-39),
        {
          ts: Date.now(),
          provider: String(e.provider || ""),
          step: "success",
          message: "login succeeded",
          level: "success" as const,
        },
      ],
    );
  });

  async function handleStart(config: {
    mode: "empas" | "refresh-token";
    empas: string;
    refreshTokens: string;
    concurrent: number;
    skipExisting: boolean;
    useProxy: boolean;
    captchaBehavior: "skip" | "handle";
    headless: boolean;
    autoUpgrade: boolean;
  }) {
    const text = config.mode === "empas" ? config.empas : config.refreshTokens;
    if (!text.trim()) {
      alert("Paste at least one line.");
      return;
    }
    try {
      await importAccounts(text, [modalProvider!.value], {
        headless: config.headless,
        concurrency: config.concurrent,
      });
      setModalProvider(null);
      navigate("/bot-logs");
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to start");
    }
  }

  return (
    <div className="space-y-6">
      {/* Page header — matches Dashboard/Accounts */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-[var(--foreground)]">Automation</h1>
          <p className="mt-1 text-sm text-[var(--muted-foreground)]">
            Start browser logins, then watch frames and steps on Browser Logs in real time.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              wsStatus === "open"
                ? "border-[var(--primary)]/40 text-[var(--primary)]"
                : "text-[var(--muted-foreground)]"
            }
          >
            <Radio className={`mr-1.5 h-3 w-3 ${wsStatus === "open" ? "animate-pulse text-[var(--primary)]" : ""}`} />
            WS {wsStatus}
          </Badge>
          <Button variant="outline" size="sm" onClick={() => navigate("/bot-logs")}>
            <Monitor className="mr-2 h-4 w-4" />
            Browser Logs
            <ArrowRight className="ml-1.5 h-3.5 w-3.5 opacity-60" />
          </Button>
        </div>
      </div>

      {/* How it connects */}
      <Card className="border-[var(--primary)]/20 bg-[var(--card)] shadow-[var(--shadow-card)]">
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-1 flex-wrap items-center gap-2 text-xs sm:text-sm">
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2.5 py-1.5 text-[var(--foreground)]">
              <Zap className="h-3.5 w-3.5 text-[var(--primary)]" />
              1. Start provider
            </span>
            <ArrowRight className="hidden h-4 w-4 text-[var(--muted-foreground)] sm:inline" />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--border)] bg-[var(--secondary)] px-2.5 py-1.5 text-[var(--foreground)]">
              <Bot className="h-3.5 w-3.5 text-[var(--primary)]" />
              2. Camoufox login
            </span>
            <ArrowRight className="hidden h-4 w-4 text-[var(--muted-foreground)] sm:inline" />
            <span className="inline-flex items-center gap-1.5 rounded-md border border-[var(--primary)]/40 bg-[color-mix(in_srgb,var(--primary)_12%,transparent)] px-2.5 py-1.5 text-[var(--foreground)]">
              <Monitor className="h-3.5 w-3.5 text-[var(--primary)]" />
              3. Browser Logs live
            </span>
          </div>
          <p className="max-w-md text-xs text-[var(--muted-foreground)]">
            Progress steps and JPEG frames register as a browser session so the Logs page can stream them — same registry as batch automation.
          </p>
        </CardContent>
      </Card>

      {/* Provider grid */}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PROVIDERS.map((p) => {
          const Icon = p.icon;
          return (
            <Card
              key={p.value}
              className={`group relative overflow-hidden transition-shadow hover:shadow-[var(--glow)] ${
                p.comingSoon ? "opacity-55" : ""
              }`}
            >
              <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--primary)]/50 to-transparent opacity-0 transition-opacity group-hover:opacity-100" />
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg border border-[var(--border)] bg-[color-mix(in_srgb,var(--primary)_12%,var(--card))]">
                      <Icon className="h-5 w-5 text-[var(--primary)]" />
                    </div>
                    <div>
                      <CardTitle className="flex items-center gap-2 text-base">
                        {p.label}
                        <Badge variant="outline" className="text-[10px] font-normal uppercase tracking-wide">
                          {p.engine}
                        </Badge>
                      </CardTitle>
                      <CardDescription className="mt-1 text-xs">{p.subtitle}</CardDescription>
                    </div>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-4 pt-0">
                <p className="min-h-[2.5rem] text-xs leading-relaxed text-[var(--muted-foreground)]">
                  {p.description}
                </p>
                <div className="flex items-center justify-between gap-2">
                  {p.comingSoon ? (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--muted-foreground)]">
                      <CircleDashed className="h-3.5 w-3.5" /> Coming soon
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-xs text-[var(--primary)]">
                      <CheckCircle2 className="h-3.5 w-3.5" /> Ready
                    </span>
                  )}
                  {p.comingSoon ? (
                    <Button variant="outline" size="sm" disabled>
                      Coming soon
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => setModalProvider(p)}>
                      Start
                      <ArrowRight className="ml-1.5 h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Live strip — shared WS stream Browser Logs also consumes */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-3">
          <div>
            <CardTitle className="text-sm">Live activity</CardTitle>
            <CardDescription className="text-xs">
              Same WebSocket events as Browser Logs ({live.length} recent)
            </CardDescription>
          </div>
          <Button variant="ghost" size="sm" onClick={() => navigate("/bot-logs")}>
            Open logs
            <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
          </Button>
        </CardHeader>
        <CardContent>
          {live.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border)] bg-[var(--secondary)]/40 px-4 py-8 text-center text-xs text-[var(--muted-foreground)]">
              No login events yet. Start a provider to stream progress here.
            </div>
          ) : (
            <div className="max-h-48 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--secondary)]/30 font-mono text-[11px]">
              {live.slice().reverse().map((ev, i) => (
                <div
                  key={`${ev.ts}-${i}`}
                  className="flex gap-2 border-b border-[var(--border)]/60 px-3 py-1.5 last:border-0"
                >
                  <span className="shrink-0 text-[var(--muted-foreground)]">
                    {new Date(ev.ts).toLocaleTimeString()}
                  </span>
                  <span className="shrink-0 text-[var(--primary)]">{ev.provider || "—"}</span>
                  <span
                    className={
                      ev.level === "error"
                        ? "text-[var(--error)]"
                        : ev.level === "success"
                          ? "text-[var(--success)]"
                          : "text-[var(--warning)]"
                    }
                  >
                    {ev.step}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-[var(--foreground)]">{ev.message}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {modalProvider && (
        <StartAutomationModal
          provider={modalProvider.value}
          providerLabel={modalProvider.label}
          subtitle={`Run ${modalProvider.label} login. Progress and frames open on Browser Logs automatically.`}
          onClose={() => setModalProvider(null)}
          onStart={handleStart}
        />
      )}
    </div>
  );
}
