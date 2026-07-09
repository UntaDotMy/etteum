import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ExternalLink } from "lucide-react";
import StartAutomationModal from "@/components/automation/StartAutomationModal";
import { importAccounts } from "@/lib/api";

interface ProviderConfig {
  value: string;
  label: string;
  subtitle: string;
  description: string;
  icon: string;
  color: string;
  comingSoon?: boolean;
}

const PROVIDERS: ProviderConfig[] = [
  {
    value: "antigravity",
    label: "Antigravity",
    subtitle: "Auto-add Antigravity accounts using empas.",
    description: "Standalone Antigravity autologin flow with shared Browser Logs.",
    icon: "🚀",
    color: "from-purple-500/20 to-purple-600/20",
  },
  {
    value: "kiro",
    label: "Kiro",
    subtitle: "Auto-add Kiro accounts using empas.",
    description: "Standalone Kiro-only autologin flow (enowxai + Camoufox stealth).",
    icon: "⚡",
    color: "from-blue-500/20 to-blue-600/20",
  },
  {
    value: "codebuddy",
    label: "CodeBuddy",
    subtitle: "Auto-add CodeBuddy accounts using empas.",
    description: "Standalone CodeBuddy autologin flow with shared Browser Logs (enowxai + Camoufox stealth).",
    icon: "🤖",
    color: "from-cyan-500/20 to-cyan-600/20",
  },
  {
    value: "codebuddy-cn",
    label: "CodeBuddy CN",
    subtitle: "Register CodeBuddy CN accounts via Warpize OTP + HTTP API — no browser.",
    description: "CodeBuddy CN automation — Warpize OTP registration.",
    icon: "🤖",
    color: "from-slate-500/20 to-slate-600/20",
    comingSoon: true,
  },
  {
    value: "qoder",
    label: "Qoder",
    subtitle: "Auto-add Qoder accounts using empas.",
    description: "Qoder device-flow login with Google click before auth.",
    icon: "🌐",
    color: "from-green-500/20 to-green-600/20",
    comingSoon: true,
  },
  {
    value: "canva",
    label: "Canva",
    subtitle: "Auto-add Canva accounts using empas.",
    description: "Standalone Canva autologin flow.",
    icon: "🎨",
    color: "from-pink-500/20 to-pink-600/20",
    comingSoon: true,
  },
];

export default function Automation() {
  const navigate = useNavigate();
  const [modalProvider, setModalProvider] = useState<ProviderConfig | null>(null);

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
    <div className="min-h-screen bg-[var(--background)]">
      {/* Header */}
      <div className="border-b border-[var(--border)] px-6 py-4">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wider text-[var(--muted-foreground)]">Workspace</div>
            <h1 className="text-2xl font-bold">Automation</h1>
            <p className="text-sm text-[var(--muted-foreground)]">Operational tools and assisted workflows.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => navigate("/bot-logs")}>
              <ExternalLink className="h-4 w-4 mr-2" /> Browser Log
            </Button>
          </div>
        </div>
      </div>

      {/* Provider cards grid */}
      <div className="p-6">
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3">
          {PROVIDERS.map((p) => (
            <div
              key={p.value}
              className={`relative rounded-lg border border-[var(--border)] bg-gradient-to-br ${p.color} p-6 ${p.comingSoon ? "opacity-60" : ""}`}
            >
              {/* Header */}
              <div className="mb-4 flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[var(--background)]/80 text-xl">
                    {p.icon}
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-lg font-semibold">{p.label}</span>
                      <Badge variant="outline" className="text-xs">AUTOMATION</Badge>
                    </div>
                    <p className="text-xs text-[var(--muted-foreground)]">{p.subtitle}</p>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div className="mb-6 rounded-md border border-[var(--border)] bg-[var(--background)]/50 p-3 text-xs text-[var(--muted-foreground)]">
                <span className="mr-1">⚡</span> {p.description}
              </div>

              {/* Start button */}
              {p.comingSoon ? (
                <Button variant="outline" size="sm" disabled className="absolute bottom-6 right-6">
                  Coming soon
                </Button>
              ) : (
                <Button
                  size="sm"
                  className="absolute bottom-6 right-6"
                  onClick={() => setModalProvider(p)}
                >
                  Start
                </Button>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Modal */}
      {modalProvider && (
        <StartAutomationModal
          provider={modalProvider.value}
          providerLabel={modalProvider.label}
          subtitle={`Run browser-based ${modalProvider.label} add or import refresh tokens into the same Browser Logs flow.`}
          onClose={() => setModalProvider(null)}
          onStart={handleStart}
        />
      )}
    </div>
  );
}
