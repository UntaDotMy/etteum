import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Plus,
  Copy,
  Check,
  Pencil,
  Power,
  Trash2,
  Loader2,
  KeyRound,
  Infinity as InfinityIcon,
  Link2,
  ExternalLink,
} from "lucide-react";
import { useApiCache } from "@/hooks/useApiCache";
import {
  fetchManagedKeys,
  fetchPoolInfo,
  revokeManagedKey,
  activateManagedKey,
  deleteManagedKey,
  type ManagedKey,
} from "@/lib/api";
import KeyFormDialog from "./KeyFormDialog";

/** Recently-connected window: a key whose lastUsedAt is within this is "connected". */
const CONNECTED_WINDOW_MS = 60_000;

export default function ManagedKeys(props: { onError: (msg: string) => void; onInfo: (msg: string) => void }) {
  const { onError, onInfo } = props;
  const { data, mutate, isValidating } = useApiCache<{ keys: ManagedKey[] }>(
    "managed-keys",
    () => fetchManagedKeys(),
    { staleTime: 10_000 },
  );
  const keys = data?.keys ?? [];

  // Public status page URL (optional link for operators; not labeled as share/friend).
  const { data: info } = useApiCache<{ share?: { url: string | null } }>(
    "pool-info",
    () => fetchPoolInfo(),
    { staleTime: 60_000 },
  );
  const statusBase = info?.share?.url ?? null;

  function statusPageUrl(): string {
    return (statusBase || window.location.origin).replace(/\/$/, "") || window.location.origin;
  }

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<ManagedKey | null>(null);
  const [createdKey, setCreatedKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copiedKeyId, setCopiedKeyId] = useState<number | null>(null);
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedLinkId, setCopiedLinkId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleting, setDeleting] = useState<ManagedKey | null>(null);

  async function run(id: number, fn: () => Promise<unknown>, okMsg: string) {
    setBusyId(id);
    try {
      await fn();
      onInfo(okMsg);
      await mutate();
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  }

  function openCreate() {
    setEditing(null);
    setFormOpen(true);
  }
  function openEdit(k: ManagedKey) {
    setEditing(k);
    setFormOpen(true);
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1800);
      },
      () => onError("Could not copy to clipboard."),
    );
  }

  /** Always copy the full managed key, never the truncated preview. */
  function copyFullKey(k: ManagedKey) {
    const full = k.key?.trim();
    if (!full) {
      onError("Full key unavailable for this row. Create a new key if you need the secret.");
      return;
    }
    navigator.clipboard.writeText(full).then(
      () => {
        setCopiedKeyId(k.id);
        setTimeout(() => setCopiedKeyId((c) => (c === k.id ? null : c)), 1800);
        onInfo("Full API key copied.");
      },
      () => onError("Could not copy to clipboard."),
    );
  }

  function copyStatusLink(k: ManagedKey) {
    navigator.clipboard.writeText(statusPageUrl()).then(
      () => {
        setCopiedLinkId(k.id);
        setTimeout(() => setCopiedLinkId((c) => (c === k.id ? null : c)), 1800);
        onInfo("Status page link copied.");
      },
      () => onError("Could not copy link."),
    );
  }

  return (
    <>
      <Card className="border-[var(--border)]">
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <KeyRound className="w-4 h-4" /> Managed keys
              {isValidating && <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--muted-foreground)]" />}
            </CardTitle>
            <CardDescription>
              Per-key models, quota, rate, and expiry. Use <strong>Copy API key</strong> for the
              full secret. Keys only authenticate <span className="font-mono">/v1/*</span>.
            </CardDescription>
          </div>
          <Button size="sm" onClick={openCreate}>
            <Plus className="w-4 h-4" /> New key
          </Button>
        </CardHeader>

        <CardContent>
          {keys.length === 0 ? (
            <div className="rounded-md border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted-foreground)]">
              No keys yet. Create one to set limits and access.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-2">
              {keys.map((k) => (
                <KeyCard
                  key={k.id}
                  k={k}
                  busy={busyId === k.id}
                  linkCopied={copiedLinkId === k.id}
                  onCopyLink={() => copyStatusLink(k)}
                  onEdit={() => openEdit(k)}
                  onToggle={() =>
                    run(
                      k.id,
                      () => (k.isActive ? revokeManagedKey(k.id) : activateManagedKey(k.id)),
                      k.isActive ? "Key revoked." : "Key activated.",
                    )
                  }
                  onDelete={() => setDeleting(k)}
                  keyCopied={copiedKeyId === k.id}
                  onCopy={() => copyFullKey(k)}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <KeyFormDialog
        open={formOpen}
        onOpenChange={setFormOpen}
        editing={editing}
        onCreated={(fullKey) => {
          setCreatedKey(fullKey);
          void mutate();
        }}
        onSaved={() => {
          onInfo("Key updated.");
          void mutate();
        }}
        onError={onError}
      />

      {/* Show-once dialog for a freshly created key */}
      <Dialog
        open={createdKey != null}
        onOpenChange={(o) => {
          if (!o) {
            setCreatedKey(null);
            setCopiedLink(false);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Key created</DialogTitle>
            <DialogDescription>
              Copy the full API key now (or anytime from the card). You can re-copy later from the
              list.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <div className="text-xs font-medium text-[var(--muted-foreground)] mb-1">API key</div>
              <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2">
                <code className="flex-1 break-all font-mono text-sm text-[var(--primary)] select-all blur-[5px] hover:blur-none transition-[filter] duration-150">
                  {createdKey}
                </code>
                <Button variant="outline" size="icon" onClick={() => createdKey && copy(createdKey)} title="Copy full API key">
                  {copied ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Copy className="w-4 h-4" />}
                </Button>
              </div>
            </div>
            <div>
              <div className="text-xs font-medium text-[var(--muted-foreground)] mb-1">Status page</div>
              <div className="flex items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--background)] px-3 py-2">
                <code className="flex-1 break-all font-mono text-xs text-[var(--foreground)]">
                  {statusPageUrl()}
                </code>
                <Button
                  variant="outline"
                  size="icon"
                  title="Copy status page URL"
                  onClick={() => {
                    navigator.clipboard.writeText(statusPageUrl()).then(
                      () => {
                        setCopiedLink(true);
                        setTimeout(() => setCopiedLink(false), 1800);
                        onInfo("Status page link copied.");
                      },
                      () => onError("Could not copy link."),
                    );
                  }}
                >
                  {copiedLink ? <Check className="w-4 h-4 text-[var(--success)]" /> : <Link2 className="w-4 h-4" />}
                </Button>
              </div>
            </div>
          </div>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              onClick={() => window.open(statusPageUrl(), "_blank", "noopener,noreferrer")}
            >
              <ExternalLink className="w-4 h-4" />
              Open status page
            </Button>
            <Button onClick={() => setCreatedKey(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirmation */}
      <Dialog open={deleting != null} onOpenChange={(o) => !o && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete key</DialogTitle>
            <DialogDescription>
              Permanently delete <span className="font-mono">{deleting?.keyPreview}</span>
              {deleting?.name ? ` (${deleting.name})` : ""}? It stops working immediately. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = deleting!.id;
                setDeleting(null);
                void run(id, () => deleteManagedKey(id), "Key deleted.");
              }}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function statusOf(k: ManagedKey): { label: string; variant: "success" | "warning" | "error" | "secondary" } {
  const now = Date.now();
  const expired = k.expiresAt != null && new Date(k.expiresAt).getTime() <= now;
  const exhausted = k.tokenQuota != null && (k.tokensUsed ?? 0) >= k.tokenQuota;
  if (!k.isActive) return { label: "revoked", variant: "secondary" };
  if (expired) return { label: "expired", variant: "error" };
  if (exhausted) return { label: "exhausted", variant: "warning" };
  return { label: "active", variant: "success" };
}

function KeyCard(props: {
  k: ManagedKey;
  busy: boolean;
  linkCopied: boolean;
  keyCopied: boolean;
  onCopyLink: () => void;
  onEdit: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onCopy: () => void;
}) {
  const { k, busy, linkCopied, keyCopied, onCopyLink, onEdit, onToggle, onDelete, onCopy } = props;
  const st = statusOf(k);
  const connected = k.isActive && k.lastUsedAt != null && Date.now() - new Date(k.lastUsedAt).getTime() < CONNECTED_WINDOW_MS;
  const hasQuota = k.tokenQuota != null && k.tokenQuota > 0;
  const pct = hasQuota ? Math.min(100, ((k.tokensUsed ?? 0) / k.tokenQuota!) * 100) : 0;
  const models = k.allowedModels ?? null;

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--card)] p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-[var(--foreground)] truncate">{k.name || "Key"}</div>
          <button
            type="button"
            onClick={onCopy}
            title="Copy full API key"
            className="font-mono text-xs text-[var(--muted-foreground)] hover:text-[var(--foreground)] max-w-full inline-flex items-center gap-1.5"
          >
            <span className="truncate max-w-[11rem] blur-[4px] hover:blur-none transition-[filter] duration-150 select-none">
              {k.key || k.keyPreview}
            </span>
            {keyCopied ? (
              <Check className="w-3 h-3 shrink-0 text-[var(--success)]" />
            ) : (
              <Copy className="w-3 h-3 shrink-0 opacity-60" />
            )}
          </button>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {connected && (
            <Badge variant="success" className="gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-current inline-block" />
              connected
            </Badge>
          )}
          <Badge variant={st.variant}>{st.label}</Badge>
        </div>
      </div>

      <div>
        <div className="flex justify-between text-[11px] text-[var(--muted-foreground)] mb-1">
          <span>tokens</span>
          {hasQuota ? (
            <span className="font-mono">
              {fmt(k.tokensUsed)} / {fmt(k.tokenQuota)} · {pct.toFixed(0)}%
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 font-mono">
              <InfinityIcon className="w-3 h-3" /> unlimited
            </span>
          )}
        </div>
        {hasQuota && (
          <Progress
            value={pct}
            indicatorClassName={pct >= 100 ? "bg-[var(--error)]" : pct >= 80 ? "bg-[var(--warning)]" : "bg-[var(--primary)]"}
          />
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
        <Meta k_="created" v={k.createdAt ? new Date(k.createdAt).toLocaleDateString() : "—"} />
        <Meta k_="last used" v={k.lastUsedAt ? rel(k.lastUsedAt) : "never"} />
        <Meta k_="rate" v={k.rateLimit ? `${k.rateLimit}/min` : "no cap"} />
        <Meta k_="expires" v={k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : "never"} />
      </div>

      <div className="flex flex-wrap gap-1">
        {models == null ? (
          <span className="text-[11px] text-[var(--muted-foreground)]">all models</span>
        ) : (
          <>
            {models.slice(0, 4).map((m) => (
              <span
                key={m}
                className="font-mono text-[10px] rounded-full border border-[var(--border)] px-2 py-0.5 text-[var(--muted-foreground)]"
              >
                {m}
              </span>
            ))}
            {models.length > 4 && (
              <span className="text-[10px] text-[var(--muted-foreground)]">+{models.length - 4} more</span>
            )}
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 pt-1 border-t border-[var(--border)]">
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="h-8 gap-1.5 text-xs"
          onClick={onCopy}
          disabled={busy}
          title="Copy full API key"
        >
          {keyCopied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Copy className="w-3.5 h-3.5" />}
          {keyCopied ? "Copied" : "Copy API key"}
        </Button>
        <IconBtn
          title="Copy status page URL"
          onClick={onCopyLink}
          disabled={busy}
        >
          {linkCopied ? <Check className="w-3.5 h-3.5 text-[var(--success)]" /> : <Link2 className="w-3.5 h-3.5" />}
        </IconBtn>
        <IconBtn title="Edit limits" onClick={onEdit} disabled={busy}>
          <Pencil className="w-3.5 h-3.5" />
        </IconBtn>
        <IconBtn title={k.isActive ? "Revoke" : "Activate"} onClick={onToggle} disabled={busy}>
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Power className="w-3.5 h-3.5" />}
        </IconBtn>
        <IconBtn title="Delete" onClick={onDelete} disabled={busy} danger>
          <Trash2 className="w-3.5 h-3.5" />
        </IconBtn>
      </div>
    </div>
  );
}

function Meta(props: { k_: string; v: string }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="uppercase tracking-wider text-[var(--muted-foreground)]">{props.k_}</span>
      <span className="font-mono text-[var(--foreground)]">{props.v}</span>
    </div>
  );
}

function IconBtn(props: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md border border-[var(--border)] text-[var(--muted-foreground)] transition-colors hover:text-[var(--foreground)] hover:bg-[var(--secondary)] disabled:opacity-50 ${
        props.danger ? "hover:text-[var(--error)] hover:border-[var(--error)]/50" : ""
      }`}
    >
      {props.children}
    </button>
  );
}

function fmt(n: number | null | undefined): string {
  if (n == null) return "∞";
  const v = Math.round(n);
  if (v >= 1e9) return (v / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (v >= 1e6) return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (v >= 1e3) return (v / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(v);
}

function rel(iso: string): string {
  const t = new Date(iso).getTime();
  if (isNaN(t)) return "—";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}
