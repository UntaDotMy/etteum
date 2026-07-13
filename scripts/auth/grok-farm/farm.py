#!/usr/bin/env python3
"""
Standalone Grok / xAI account farmer (CLI-only).

Flow per account:
  1. Generate email (catch-all domain OR Gmail plus-trick OR temp-mail)
  2. Camoufox browser → accounts.x.ai/sign-up
  3. Email → OTP (IMAP / generator.email) → Confirm
  4. Name + password + Turnstile → Complete sign up
  5. Login if needed → OAuth PKCE (Grok CLI) → tokens
  6. Activate on grok.com (web login / CF) — unlocks free Build chat for many accounts
  7. Probe cli-chat-proxy /v1/responses model=grok-4.5 (must not 403)
  8. Only then append result to JSON + TXT.
     Chat 403: tempmail blacklists that generator domain + re-rolls;
               google NEVER blacklists (fixed catch-all / Gmail domain).

Config: copy .env.example → .env then edit.
Run:    ./run.sh   or   python farm.py
"""
from __future__ import annotations

import asyncio
import base64
import glob
import hashlib
import imaplib
import json
import os
import random
import re
import secrets
import shutil
import signal
import string
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from email import message_from_bytes
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs, urlencode, urlparse, unquote

# Dedicated pool for blocking I/O (disk, process kill, temp sweeps).
# Keeps the asyncio event loop free so the HUD ticker never freezes.
_IO_POOL = ThreadPoolExecutor(max_workers=8, thread_name_prefix="farm-io")


async def _run_io(fn: Callable[..., Any], /, *args: Any, **kwargs: Any) -> Any:
    """Run blocking fn in the I/O thread pool (never blocks the event loop)."""
    loop = asyncio.get_running_loop()
    if kwargs:
        return await loop.run_in_executor(_IO_POOL, lambda: fn(*args, **kwargs))
    return await loop.run_in_executor(_IO_POOL, fn, *args)

# Load .env from script directory
_ROOT = Path(__file__).resolve().parent
try:
    from dotenv import load_dotenv
    # When Etteum hosts the farm (ETTEUM_FRAME_RELAY / ETTEUM_FARM_HOST), process
    # env already has the full config from the UI — do NOT let local .env clobber it.
    # Standalone: empty env → .env fills everything (override=False still loads missing keys).
    _hosted = bool(
        os.environ.get("ETTEUM_FRAME_RELAY") or os.environ.get("ETTEUM_FARM_HOST")
    )
    load_dotenv(_ROOT / ".env", override=not _hosted)
except ImportError:
    env_path = _ROOT / ".env"
    if env_path.is_file():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k, v = k.strip(), v.strip().strip('"').strip("'")
            # Match dotenv override=False: never replace keys already set by host
            os.environ.setdefault(k, v)

try:
    from camoufox.async_api import AsyncCamoufox
except ImportError:
    print("ERROR: camoufox not installed. Run: ./install.sh", flush=True)
    sys.exit(1)

# ── Config from env ──────────────────────────────────────────────────────────
def _env(key: str, default: str = "") -> str:
    return (os.environ.get(key) or default).strip()

def _env_bool(key: str, default: bool = True) -> bool:
    raw = _env(key, "true" if default else "false").lower()
    return raw in ("1", "true", "yes", "on")

IMAP_USER = _env("GROK_IMAP_USER")
IMAP_PASS = _env("GROK_IMAP_PASS").replace(" ", "")
IMAP_HOST = _env("GROK_IMAP_HOST", "imap.gmail.com")
IMAP_PORT = int(_env("GROK_IMAP_PORT", "993") or "993")
EMAIL_DOMAIN = _env("GROK_EMAIL_DOMAIN").lstrip("@")
EMAIL_MODE = _env("GROK_EMAIL_MODE", "domain").lower()
if EMAIL_MODE not in ("plus_trick", "domain"):
    EMAIL_MODE = "domain"
# Top-level email provider: "google" (existing Gmail/domain + IMAP) or
# "tempmail" (generator.email via a visible browser — no IMAP needed).
# Set at runtime by the startup menu; GROK_MAIL_MODE is the default/fallback.
MAIL_MODE = _env("GROK_MAIL_MODE", "google").lower()
if MAIL_MODE not in ("google", "tempmail"):
    MAIL_MODE = "google"
# temp-mail browser runs headless. Set GROK_TEMPMAIL_HEADLESS=false to watch it.
TEMPMAIL_HEADLESS = _env_bool("GROK_TEMPMAIL_HEADLESS", True)
GMAIL_BASE = _env("GROK_GMAIL_BASE").lower() or IMAP_USER.lower()
ACCOUNT_PASSWORD = _env("GROK_PASSWORD", "$Priyo000")
MAX_ACCOUNTS = int(_env("GROK_MAX_ACCOUNTS", "5") or "5")
CONCURRENT = int(_env("GROK_CONCURRENT", "1") or "1")
HEADLESS = _env_bool("GROK_HEADLESS", False)  # headed recommended for Turnstile
# 0 = no stagger (workers start together). Isolation mode defaults toward 0.
SPAWN_DELAY = float(_env("GROK_SPAWN_DELAY", "0") or "0")

# Fail-fast timeouts (stuck / unclear page states should free the worker slot)
OTP_TIMEOUT_S = max(30, int(_env("GROK_OTP_TIMEOUT", "120") or "120"))
# whole account hard deadline (signup+login+oauth)
ACCOUNT_TIMEOUT_S = max(120, int(_env("GROK_ACCOUNT_TIMEOUT", "480") or "480"))  # 8 min
# refresh (re-auth existing account): login+oauth only, no signup — much shorter.
# Dead accounts should fail fast rather than hold a worker for 8 min.
REFRESH_TIMEOUT_S = max(60, int(_env("GROK_REFRESH_TIMEOUT", "150") or "150"))  # 2.5 min
# Auto-retries per account on refresh fail (Turnstile/CF/driver flakiness).
# Retries are IMMEDIATE on the same account (not sent to the back of the queue):
# fail → short backoff → new browser → try again, up to this many times.
# Permanent fail only after all tries. Default 5 → high chance of full coverage.
REFRESH_RETRIES = max(1, min(30, int(_env("GROK_REFRESH_RETRIES", "5") or "5")))
# Backoff base (seconds) between tries: try1→2 waits base, try2→3 waits 2*base, …
REFRESH_RETRY_BACKOFF_S = max(0.5, float(_env("GROK_REFRESH_RETRY_BACKOFF", "3") or "3"))
# complete_signup turnstile+submit: max wall time before hard fail
# 120s default: concurrent load + CF often needs 2-3 solve/submit cycles
COMPLETE_SIGNUP_TIMEOUT_S = max(30, int(_env("GROK_COMPLETE_TIMEOUT", "120") or "120"))
CONFIRM_EMAIL_TIMEOUT_S = max(15, int(_env("GROK_CONFIRM_TIMEOUT", "45") or "45"))
# Worker isolation: each slot owns Camoufox + page + Turnstile solve.
# true  = never wait on other workers for CF / browser launch (default).
# false = allow legacy TURNSTILE_PARALLEL serialize if use_global_limit=True.
WORKER_ISOLATION = _env_bool("GROK_WORKER_ISOLATION", True)
# Optional Turnstile serialize cap (ONLY if use_global_limit=True AND isolation off).
# Farm paths use use_global_limit=False — workers never take this semaphore.
_ts_par_raw = _env("GROK_TURNSTILE_PARALLEL", "")
if WORKER_ISOLATION:
    # High ceiling so accidental use_global_limit=True still doesn't queue forever
    TURNSTILE_PARALLEL = max(
        CONCURRENT,
        int(_ts_par_raw or "64") if (_ts_par_raw or "").strip() else 64,
        8,
    )
else:
    TURNSTILE_PARALLEL = max(1, int(_ts_par_raw or "1") or 1)
# Cap simultaneous Camoufox boots (not in-flight workers). At c=5 tempmail = up
# to 10 browsers; without this, all launch+page-load at once → home-net choke.
# Workers still run concurrent after boot (OTP wait, probe, etc.).
LAUNCH_PARALLEL = max(1, min(20, int(_env("GROK_LAUNCH_PARALLEL", "2") or "2")))
# When SPAWN_DELAY=0 and concurrent is high, auto-stagger starts (seconds between
# worker slot starts). Set GROK_AUTO_STAGGER=false to force zero stagger.
AUTO_STAGGER = _env_bool("GROK_AUTO_STAGGER", True)
AUTO_SPAWN_DELAY_S = max(0.0, float(_env("GROK_AUTO_SPAWN_DELAY", "2.0") or "2.0"))
# Temp-mail browser only: block images to cut bandwidth (OTP is text).
TEMPMAIL_BLOCK_IMAGES = _env_bool("GROK_TEMPMAIL_BLOCK_IMAGES", True)
# Self-heal: UI/transient failures (email form missing, CF stuck, activate fail)
# re-spawn browser + new email instead of permanent fail. Domain 403 re-rolls
# for tempmail are separate (MAX_DOMAIN_RETRIES).
UI_RETRIES = max(1, min(8, int(_env("GROK_UI_RETRIES", "3") or "3")))
UI_RETRY_BACKOFF_S = max(0.5, float(_env("GROK_UI_RETRY_BACKOFF", "2") or "2"))
# After activate, re-probe 403 a few times (IP rate-limit / entitlement lag).
PROBE_RETRIES = max(1, min(8, int(_env("GROK_PROBE_RETRIES", "5") or "5")))
PROBE_RETRY_BACKOFF_S = max(0.5, float(_env("GROK_PROBE_RETRY_BACKOFF", "2.5") or "2.5"))

# Results root: each run creates results/batch_<id>/ (unless legacy single-file paths set)
RESULTS_ROOT = Path(_env("GROK_RESULTS_DIR", str(_ROOT / "results")))
USED_EMAILS_FILE = Path(_env("GROK_USED_EMAILS_FILE", str(RESULTS_ROOT / "used_emails.txt")))
# Optional legacy override: if any of these set, write to those fixed paths (no per-batch folder)
_LEGACY_JSON = _env("GROK_RESULTS_JSON")
_LEGACY_TXT = _env("GROK_RESULTS_TXT")
_LEGACY_FAILED = _env("GROK_FAILED_JSON")
EMAIL_LOCAL_LEN = max(10, min(32, int(_env("GROK_EMAIL_LOCAL_LEN", "16") or "16")))

# Set in init_batch() at run start
BATCH_ID = ""
BATCH_DIR: Path = RESULTS_ROOT
RESULTS_JSON: Path = RESULTS_ROOT / "accounts.json"
RESULTS_TXT: Path = RESULTS_ROOT / "accounts.txt"
FAILED_JSON: Path = RESULTS_ROOT / "failed.json"
# Shared across ALL batches (top-level results/), one token per line.
ACCESS_TOKEN_FILE: Path = RESULTS_ROOT / "access_token.txt"
REFRESH_TOKEN_FILE: Path = RESULTS_ROOT / "refresh_token.txt"
# Domains xAI rejected — one per line. temp-mail re-rolls if the generated
# address lands on a blacklisted domain.
BLACKLIST_FILE: Path = RESULTS_ROOT / "blacklist_domain.txt"
SCREENSHOT_DIR = _env("GROK_SCREENSHOT_DIR", str(_ROOT / "screenshots"))
# Screenshots OFF by default — set GROK_SCREENSHOTS=true to re-enable.
SCREENSHOTS_ENABLED = _env_bool("GROK_SCREENSHOTS", False)
Path(SCREENSHOT_DIR).mkdir(parents=True, exist_ok=True)
RESULTS_ROOT.mkdir(parents=True, exist_ok=True)

# Optional vision CAPTCHA (interactive Turnstile puzzles) via OpenAI-compatible API
CAPTCHA_PROXY_URL = _env("GROK_CAPTCHA_PROXY_URL", "")
CAPTCHA_API_KEY = _env("GROK_CAPTCHA_API_KEY", "")
CAPTCHA_MODEL = _env("GROK_CAPTCHA_MODEL", "gpt-4o")

SIGNUP_URL = "https://accounts.x.ai/sign-up"
SIGNIN_URL = "https://accounts.x.ai/sign-in"

# Grok CLI OIDC — same client_id / redirect as official Grok CLI (~/.grok/auth.json)
# and CLIProxyAPI. Flow mirrors CLI:
#   1) local callback HTTP server on 127.0.0.1:56121/callback
#   2) PKCE authorize URL in browser
#   3) redirect delivers ?code= to the real server (not page.route.abort)
#   4) exchange code + verifier at auth.x.ai/oauth2/token
XAI_CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828"
XAI_AUTHORIZE = "https://auth.x.ai/oauth2/authorize"
XAI_TOKEN = "https://auth.x.ai/oauth2/token"
XAI_CALLBACK_HOST = "127.0.0.1"
XAI_CALLBACK_PORT = 56121
XAI_REDIRECT_URI = f"http://{XAI_CALLBACK_HOST}:{XAI_CALLBACK_PORT}/callback"
XAI_SCOPE = (
    "openid profile email offline_access "
    "grok-cli:access api:access conversations:read conversations:write"
)
GROK_FREE_TOKEN_LIMIT = 1_000_000
# Grok Build free CLI surface (Responses API + grok-4.5 only — no grok-build fallback).
CLI_RESPONSES_URL = "https://cli-chat-proxy.grok.com/v1/responses"
CLI_PROBE_MODEL = "grok-4.5"
CLI_VERSION_URL = "https://x.ai/cli/stable"
CLI_VERSION_FALLBACK = "0.2.93"
_CLI_VERSION_CACHE: str | None = None
# Visit grok.com after OAuth so free Build entitlement can attach (refer path).
# Set GROK_ACTIVATE_WEB=false to skip (not recommended — often causes 403).
ACTIVATE_WEB = _env_bool("GROK_ACTIVATE_WEB", True)

FIRST_NAMES = [
    "Alex", "Jordan", "Taylor", "Morgan", "Casey", "Riley", "Quinn", "Avery",
    "Parker", "Sage", "River", "Skyler", "Dakota", "Reese", "Finley", "Rowan",
    "Charlie", "Emerson", "Hayden", "Jamie", "Blake", "Drew", "Eden", "Kai",
    "Noah", "Liam", "Emma", "Olivia", "Mia", "Lucas", "Mason", "Sophia",
]
LAST_NAMES = [
    "Smith", "Johnson", "Williams", "Brown", "Jones", "Garcia", "Miller",
    "Davis", "Rodriguez", "Martinez", "Anderson", "Taylor", "Thomas", "Moore",
    "Jackson", "Martin", "Lee", "Thompson", "White", "Harris", "Clark", "Lewis",
    "Walker", "Hall", "Allen", "Young", "King", "Wright", "Scott", "Green",
]

# ── Proxy pool ───────────────────────────────────────────────────────────────
# Sources (merged, de-duped by URL):
#   1) GROK_PROXY_FILE  — path to list file (default: ./proxies.txt if exists)
#   2) GROK_PROXY_POOL  — comma-separated URLs (optional #id suffix)
#   3) BATCHER_PROXY_URL — single proxy fallback
#
# Line formats in proxy file (blank / #comment ignored):
#   http://user:pass@host:port
#   socks5://user:pass@host:port
#   host:port
#   host:port:user:pass
#   user:pass@host:port
#   scheme://host:port#optional_id

def _normalize_proxy_url(raw: str) -> str | None:
    """Turn free-form proxy string into a URL Camoufox/Playwright accepts."""
    s = (raw or "").strip()
    if not s:
        return None
    # strip surrounding quotes
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    if not s:
        return None

    # Already has scheme
    if "://" in s:
        return s

    parts = s.split(":")
    # host:port:user:pass  (reseller format; pass may contain ':' or '@')
    # Detect before user:pass@host so passwords with @ still work.
    if len(parts) >= 4 and parts[1].isdigit() and "@" not in parts[0]:
        host, port, user = parts[0], parts[1], parts[2]
        password = ":".join(parts[3:])
        if host and user:
            return f"http://{user}:{password}@{host}:{port}"

    # user:pass@host:port
    if "@" in s:
        return f"http://{s}"

    # host:port
    if len(parts) == 2 and parts[1].isdigit():
        return f"http://{parts[0]}:{parts[1]}"
    # bare host — reject (need port)
    return None


def _parse_proxy_entry(item: str) -> tuple[str, str] | None:
    """Parse one proxy entry → (url, optional_id) or None."""
    item = (item or "").strip()
    if not item or item.startswith("#"):
        return None
    # inline comment: url  # note  (but keep user:pass#weird if scheme present carefully)
    # Prefer optional id after last unquoted ' #' or trailing #id without space when URL has scheme
    pid = ""
    if " #" in item:
        item, _, comment = item.partition(" #")
        item = item.strip()
        pid = comment.strip()
    elif item.count("#") == 1 and "://" in item:
        # http://host:port#myid
        url_part, _, maybe_id = item.partition("#")
        item, pid = url_part.strip(), maybe_id.strip()
    url = _normalize_proxy_url(item)
    if not url:
        return None
    return (url, pid)


def _load_proxy_file(path: Path) -> list[tuple[str, str]]:
    """Load proxies — one per line (standard)."""
    if not path.is_file():
        return []
    out: list[tuple[str, str]] = []
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError as e:
        print(f"[proxy] WARN: cannot read {path}: {e}", flush=True)
        return []
    for lineno, line in enumerate(text.splitlines(), 1):
        raw = line.strip()
        if not raw or raw.startswith("#"):
            continue
        parsed = _parse_proxy_entry(raw)
        if parsed:
            out.append(parsed)
        else:
            print(f"[proxy] WARN: skip bad line {path.name}:{lineno}: {raw[:60]}", flush=True)
    return out


def _load_proxy_pool() -> tuple[list[tuple[str, str]], str]:
    """Return (pool, source_description)."""
    pool: list[tuple[str, str]] = []
    sources: list[str] = []

    # 1) File list
    file_env = _env("GROK_PROXY_FILE")
    if file_env:
        pfile = Path(file_env).expanduser()
        if not pfile.is_absolute():
            pfile = (_ROOT / pfile).resolve()
    else:
        pfile = (_ROOT / "proxies.txt").resolve()
    if pfile.is_file():
        loaded = _load_proxy_file(pfile)
        if loaded:
            pool.extend(loaded)
            sources.append(f"file:{pfile} ({len(loaded)})")
        elif file_env:
            print(f"[proxy] WARN: GROK_PROXY_FILE={pfile} empty or unreadable", flush=True)
    elif file_env:
        print(f"[proxy] WARN: GROK_PROXY_FILE not found: {pfile}", flush=True)

    # 2) Inline env pool
    raw = os.environ.get("GROK_PROXY_POOL", "").strip()
    if raw:
        n0 = len(pool)
        for item in raw.split(","):
            parsed = _parse_proxy_entry(item.strip())
            if parsed:
                pool.append(parsed)
        if len(pool) > n0:
            sources.append(f"GROK_PROXY_POOL (+{len(pool) - n0})")

    # 3) Single fallback
    if not pool and os.environ.get("BATCHER_PROXY_URL", "").strip():
        parsed = _parse_proxy_entry(os.environ["BATCHER_PROXY_URL"].strip())
        if parsed:
            pool.append(parsed)
            sources.append("BATCHER_PROXY_URL")

    # de-dupe by URL keep first id
    seen: set[str] = set()
    uniq: list[tuple[str, str]] = []
    for url, pid in pool:
        if url in seen:
            continue
        seen.add(url)
        uniq.append((url, pid))

    if uniq and _env_bool("GROK_PROXY_SHUFFLE", False):
        random.shuffle(uniq)
        sources.append("shuffled")

    desc = ", ".join(sources) if sources else "direct (no proxy file/env)"
    return uniq, desc


PROXY_POOL, PROXY_SOURCE = _load_proxy_pool()
_proxy_idx = 0
_proxy_lock = asyncio.Lock()
# Cap concurrent Turnstile solves — shared IP gets CF "Verification failed" under hammer
_turnstile_sem: asyncio.Semaphore | None = None


def _get_turnstile_sem() -> asyncio.Semaphore:
    global _turnstile_sem
    if _turnstile_sem is None:
        _turnstile_sem = asyncio.Semaphore(TURNSTILE_PARALLEL)
    return _turnstile_sem


async def next_proxy():
    global _proxy_idx
    if not PROXY_POOL:
        return (None, "")
    async with _proxy_lock:
        url, pid = PROXY_POOL[_proxy_idx % len(PROXY_POOL)]
        _proxy_idx += 1
        return (url, pid)


def _parse_proxy(url: str) -> dict:
    if "://" not in url:
        url = f"http://{url}"
    u = urlparse(url)
    scheme = (u.scheme or "http").lower()
    server = f"{scheme}://{u.hostname}"
    if u.port:
        server += f":{u.port}"
    out: dict[str, Any] = {"server": server}
    if u.username:
        out["username"] = unquote(u.username)
    if u.password:
        out["password"] = unquote(u.password)
    return out


# ── Logging / HUD ────────────────────────────────────────────────────────────
_attempt_proxy: dict[int, str] = {}

# hud = progress panel (default on TTY); log = classic line spam
_UI_ENV = _env("GROK_UI", "").lower()
if _UI_ENV in ("hud", "tui", "progress"):
    UI_MODE = "hud"
elif _UI_ENV in ("log", "verbose", "full"):
    UI_MODE = "log"
else:
    UI_MODE = "hud" if sys.stdout.isatty() else "log"
VERBOSE = _env_bool("GROK_VERBOSE", False)  # force detail lines even under HUD


def _short_email(email: str, width: int = 40) -> str:
    """Fit email into width; prefer full address, then full domain, then both ends."""
    e = (email or "").strip()
    if width <= 0:
        return ""
    if len(e) <= width:
        return e
    if "@" not in e:
        if width <= 1:
            return "…"
        return e[: width - 1] + "…"
    local, _, dom = e.partition("@")
    # Prefer keeping full domain (more useful for temp-mail diagnosis)
    if len(dom) + 2 < width:  # room for "…@domain"
        keep = width - len(dom) - 2  # "…" + "@" + dom
        if keep >= 1:
            return f"{local[:keep]}…@{dom}"
    # Prefer keeping full local if domain is huge
    if len(local) + 2 < width:
        keep = width - len(local) - 2
        if keep >= 1:
            return f"{local}@…{dom[-(keep - 1):]}" if keep > 1 else f"{local}@"
    # Both ends
    if width <= 3:
        return e[:width]
    left = max(1, (width - 1) // 2)
    right = width - 1 - left
    return e[:left] + "…" + e[-right:]


def _bar(done: int, total: int, width: int = 24) -> str:
    if total <= 0:
        return "─" * width
    filled = int(width * min(done, total) / total)
    return "█" * filled + "░" * (width - filled)


# Step labels for HUD (short key → human label + pipeline index)
_STEP_META: dict[str, tuple[str, int]] = {
    "start":            ("start", 0),
    "browser":          ("browser", 1),
    "tempmail_launch":  ("temp-mail", 1),
    "tempmail_open":    ("temp-mail", 1),
    "tempmail_otp":     ("otp-mail", 4),
    "refresh":          ("refresh", 0),
    "signup_open":      ("signup", 2),
    "signup_email_btn": ("signup", 2),
    "fill_email":       ("email", 2),
    "submit_email":     ("email", 2),
    "wait_otp":         ("otp", 3),
    "fill_otp":         ("otp", 3),
    "confirm_email":    ("confirm", 4),
    "profile":          ("profile", 5),
    "complete_signup":  ("complete", 6),
    "login":            ("login", 7),
    "oauth":            ("oauth", 8),
    "token_exchange":   ("tokens", 9),
    "activate":         ("activate", 10),
    "chat_probe":       ("probe", 11),
    "cleanup":          ("cleanup", 12),
    "domain_rejected":  ("re-roll", 2),
    "retry":            ("retry", 7),
    "ui_retry":         ("retry", 1),
}
_SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏"
_PIPE_CHARS = "░▒▓█"


class FarmHUD:
    """Live terminal progress panel (fixed-height, animated, informative).

    Design rules for no leftover / no spam:
      - FIXED frame height every draw (cursor-up always lands on frame start)
      - After cursor-up, erase to end of screen (\\033[J) so garbage below dies
      - ALL stdout writes go through _io_lock (HUD frame + quiet print share it)
      - Detail lines go to farm.log only while HUD is on (never console)
      - Ticker animates spinner / pulse ~8 Hz; state updates are free
    """

    # Layout (fixed height): title, bar, stats, credits, pipeline, sep,
    #   5 workers × 2 lines, sep, 4 recent, out, bottom, footer  = 23
    FRAME_HEIGHT = 23
    # Max content width; actual paint uses min(WIDTH, terminal_cols-2) so wide
    # terminals show full emails / messages instead of early "…" truncation.
    WIDTH = 140
    WORKER_SLOTS = 5          # max concurrent rows shown (2 lines each)
    RECENT_SLOTS = 4
    REDRAW_MIN_S = 0.05       # ~20 Hz cap; ticker drives actual cadence
    TICK_S = 0.10             # 10 Hz — smooth enough, less console thrash

    def __init__(self) -> None:
        self.enabled = UI_MODE == "hud"
        self.total = 0
        self.ok = 0
        self.fail = 0
        self.batch_id = ""
        self.batch_dir = ""
        self.mode_label = ""  # "farm" | "refresh"
        self.started = time.time()
        # Free Build quota from successful probes (rate-limit tokens, not $).
        self.credits_last_remaining: float | None = None
        self.credits_last_limit: float | None = None
        self.credits_sum_limit: float = 0.0  # sum of per-account limits farmed this run
        self.credits_accounts: int = 0
        self._workers: dict[int, dict[str, Any]] = {}
        self._recent: list[str] = []
        # State lock: short critical sections only (no disk / no stdout).
        self._slock = threading.Lock()
        # Stdout lock: separate so progress updates never wait on a long paint.
        self._io_lock = threading.Lock()
        self._drawn_lines = 0
        self._started_draw = False
        self._log_fp = None
        self._real_stdout = sys.stdout
        self._tick_task: asyncio.Task | None = None
        self._ansi_ok = self._detect_ansi()
        self._last_status = ""
        self._last_sig: tuple | None = None
        self._last_draw_t = 0.0
        self._active = False
        self._anim_i = 0
        self._pulse = 0
        self._dirty = True  # set when state changes; ticker paints
        self._paint_width = self.WIDTH
        self._painting = False  # re-entrancy guard

    @staticmethod
    def fmt_credits(n: float | int | None) -> str:
        """Human quota: 2000000 → 2.0M, 53000000 → 53.0M."""
        if n is None:
            return "—"
        try:
            v = float(n)
        except (TypeError, ValueError):
            return "—"
        if v >= 1_000_000:
            return f"{v / 1_000_000:.1f}M"
        if v >= 1_000:
            return f"{v / 1_000:.1f}K"
        return f"{int(v)}"

    @staticmethod
    def _detect_ansi() -> bool:
        try:
            if not sys.stdout.isatty():
                return False
        except Exception:
            return False
        if sys.platform == "win32":
            try:
                import ctypes
                k32 = ctypes.windll.kernel32
                h = k32.GetStdHandle(-11)  # STD_OUTPUT_HANDLE
                mode = ctypes.c_uint32()
                if not k32.GetConsoleMode(h, ctypes.byref(mode)):
                    return False
                new_mode = mode.value | 0x0004  # ENABLE_VIRTUAL_TERMINAL_PROCESSING
                if not k32.SetConsoleMode(h, new_mode):
                    return False
                m2 = ctypes.c_uint32()
                k32.GetConsoleMode(h, ctypes.byref(m2))
                return bool(m2.value & 0x0004)
            except Exception:
                return False
        return True

    def open_log(self, path: Path) -> None:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._log_fp = open(path, "a", encoding="utf-8", buffering=8192)
            self._log_fp.write(f"\n===== farm start {datetime.now(timezone.utc).isoformat()} =====\n")
            self._log_fp.flush()
            self._log_buf: list[str] = []
            self._log_last_flush = time.time()
        except Exception:
            self._log_fp = None
            self._log_buf = []

    def close_log(self) -> None:
        self._flush_log(force=True)
        if self._log_fp:
            try:
                self._log_fp.close()
            except Exception:
                pass
            self._log_fp = None

    def _flush_log(self, force: bool = False) -> None:
        """Flush buffered farm.log lines. Avoid per-line fsync so HUD stays smooth."""
        buf = getattr(self, "_log_buf", None)
        if not self._log_fp or not buf:
            return
        now = time.time()
        # flush at least every 0.25s or when buffer is fat / forced
        if not force and len(buf) < 8 and (now - getattr(self, "_log_last_flush", 0)) < 0.25:
            return
        try:
            self._log_fp.write("".join(buf))
            self._log_fp.flush()
            buf.clear()
            self._log_last_flush = now
        except Exception:
            pass

    def log_line(self, line: str) -> None:
        """Always to farm.log (buffered). Console only when HUD off or VERBOSE."""
        ts = datetime.now().strftime("%H:%M:%S")
        full = f"[{ts}] {line}"
        if self._log_fp is not None:
            try:
                if not hasattr(self, "_log_buf") or self._log_buf is None:
                    self._log_buf = []
                self._log_buf.append(full + "\n")
                self._flush_log(force=False)
            except Exception:
                pass
        if self._active and self.enabled and not VERBOSE:
            return
        if not self.enabled or VERBOSE:
            try:
                with self._io_lock:
                    self._real_stdout.write(full + "\n")
                    self._real_stdout.flush()
            except Exception:
                pass

    def start(
        self,
        total: int,
        batch_id: str = "",
        batch_dir: str = "",
        mode: str = "",
    ) -> None:
        self.total = total
        self.ok = 0
        self.fail = 0
        self.batch_id = batch_id
        self.batch_dir = batch_dir
        self.mode_label = mode or ""
        self.started = time.time()
        self.credits_last_remaining = None
        self.credits_last_limit = None
        self.credits_sum_limit = 0.0
        self.credits_accounts = 0
        self._workers.clear()
        self._recent.clear()
        self._drawn_lines = 0
        self._started_draw = False
        self._last_sig = None
        self._last_draw_t = 0.0
        self._anim_i = 0
        self._pulse = 0
        self._dirty = True
        self._active = True
        if self.enabled and self._ansi_ok:
            try:
                with self._io_lock:
                    self._real_stdout.write("\033[?25l")
                    self._real_stdout.flush()
            except Exception:
                pass
        self.render(force=True)

    def stop(self) -> None:
        """Leave the last frame on screen, restore cursor, release console."""
        with self._slock:
            self._active = False
        if not self.enabled:
            return
        try:
            # Final paint + show cursor (I/O lock only — never hold state lock).
            self.render(force=True)
            with self._io_lock:
                out = self._real_stdout
                if self._ansi_ok:
                    out.write("\033[?25h")
                out.write("\n")
                out.flush()
        except Exception:
            pass
        self._started_draw = False
        self._drawn_lines = 0

    @staticmethod
    def _step_label(step: str) -> str:
        meta = _STEP_META.get(step or "")
        return meta[0] if meta else (step or "?")[:10]

    @staticmethod
    def _pipeline(step: str) -> str:
        """Mini pipeline bar highlighting the current stage (0..10 = 11 dots)."""
        meta = _STEP_META.get(step or "")
        idx = meta[1] if meta else 0
        n = 12  # includes activate + chat_probe as final stages
        idx = max(0, min(int(idx), n - 1))
        parts = []
        for i in range(n):
            if i < idx:
                parts.append("●")
            elif i == idx:
                parts.append("◎")
            else:
                parts.append("○")
        return "".join(parts)

    def set_progress(self, attempt: int, step: str, message: str = "", email: str = "") -> None:
        with self._slock:
            now = time.time()
            w = self._workers.get(attempt)
            if not w:
                w = {
                    "attempt": attempt,
                    "email": email,
                    "step": step,
                    "message": message,
                    "t0": now,
                    "step_t0": now,
                    "history": [step] if step else [],
                }
            else:
                if step and step != w.get("step"):
                    w["step_t0"] = now
                    hist = w.get("history") or []
                    hist.append(step)
                    w["history"] = hist[-12:]
                if email:
                    w["email"] = email
                w["step"] = step
                w["message"] = message
            w["updated"] = now
            self._workers[attempt] = w
            self._dirty = True
        # Log only — ticker paints HUD (~12 Hz). Calling render() here under
        # concurrency 5 freezes the panel (5 workers × frequent steps).
        self.log_line(f"[{attempt}] {step:16} {message}" + (f"  <{email}>" if email else ""))

    def record_credits(
        self,
        remaining: float | int | None,
        limit: float | int | None,
    ) -> None:
        """Update batch credit totals after a successful CLI probe."""
        with self._slock:
            rem_f: float | None
            lim_f: float | None
            try:
                rem_f = float(remaining) if remaining is not None else None
            except (TypeError, ValueError):
                rem_f = None
            try:
                lim_f = float(limit) if limit is not None else None
            except (TypeError, ValueError):
                lim_f = None
            self.credits_last_remaining = rem_f
            self.credits_last_limit = lim_f
            if lim_f is not None:
                self.credits_sum_limit += lim_f
                self.credits_accounts += 1
            elif rem_f is not None:
                # Limit missing — still count account with remaining as proxy
                self.credits_sum_limit += rem_f
                self.credits_accounts += 1
            self._dirty = True

    def mark_ok(self, attempt: int, email: str, message: str = "ok") -> None:
        with self._slock:
            self.ok += 1
            dur = 0
            w = self._workers.pop(attempt, None)
            if w:
                t0 = w.get("t0") or time.time()
                dur = max(0, int(time.time() - t0))
            # Store full-ish recent text; paint clamps to terminal width.
            msg_keep = (message or "ok").replace("\n", " ").strip()
            self._recent.append(
                f"✓ #{attempt} {_short_email(email, 48)}  {dur}s  {msg_keep[:90]}"
            )
            self._recent = self._recent[-8:]
            self._dirty = True
        self.log_line(f"[{attempt}] OK               {message}  <{email}>")
        # Mark dirty; next ticker frame (~80ms) paints. Avoid force-render here
        # so we never stall workers on stdout under concurrency.

    def mark_fail(self, attempt: int, message: str, error: str = "") -> None:
        with self._slock:
            self.fail += 1
            email = ""
            step = ""
            dur = 0
            w = self._workers.pop(attempt, None)
            if w:
                email = w.get("email") or ""
                step = w.get("step") or ""
                t0 = w.get("t0") or time.time()
                dur = max(0, int(time.time() - t0))
            # Prefer human message; keep short error tag as prefix when useful
            human = (message or error or "fail").replace("\n", " ").strip()
            tag = (error or "").replace("\n", " ").strip()
            if tag and tag.lower() not in human.lower() and len(tag) <= 28:
                human = f"{tag}: {human}"
            if email and email not in human:
                human = f"{_short_email(email, 36)} · {human}"
            if step:
                human = f"[{self._step_label(step)}] {human}"
            # Keep long detail; _build_lines clamps to live terminal width
            detail = human[:160]
            self._recent.append(f"✗ #{attempt} {detail}" + (f"  {dur}s" if dur else ""))
            self._recent = self._recent[-8:]
            self._dirty = True
        self.log_line(
            f"[{attempt}] FAIL             {message}"
            + (f" ({error})" if error else "")
            + (f"  <{email}>" if email else "")
        )

    @staticmethod
    def _term_cols() -> int:
        try:
            return max(50, shutil.get_terminal_size(fallback=(100, 40)).columns)
        except Exception:
            return 100

    def _fit(self, text: str, width: int, *, ellipsis: str = "…") -> str:
        """Truncate only if needed; keep as much as width allows."""
        s = (text or "").replace("\n", " ").replace("\r", " ")
        if width <= 0:
            return ""
        if len(s) <= width:
            return s
        if width == 1:
            return ellipsis[:1]
        return s[: width - len(ellipsis)] + ellipsis

    def _box(self, inner: str, width: int | None = None) -> str:
        """Pad inner text; clamp so the terminal never wraps a frame line."""
        width = width if width is not None else self._paint_width
        # content width inside borders: width - 1 after "│ "
        inner_w = max(0, width - 1)
        s = self._fit(inner or "", inner_w)
        return "│ " + s.ljust(inner_w) + "│"

    def _build_lines(self, width: int) -> list[str]:
        now = time.time()
        elapsed_s = max(0.001, now - self.started)
        elapsed = int(elapsed_s)
        mm, ss = divmod(elapsed, 60)
        hh, mm = divmod(mm, 60)
        et = f"{hh:d}:{mm:02d}:{ss:02d}" if hh else f"{mm:02d}:{ss:02d}"
        done = self.ok + self.fail
        running = len(self._workers)
        pct = int(100 * done / self.total) if self.total else 0
        rate = (done / max(elapsed_s, 1.0)) * 60.0
        left = max(0, self.total - done)
        eta_s = int(left / (done / max(elapsed_s, 1.0))) if done > 0 else 0
        if eta_s > 0:
            em, es = divmod(eta_s, 60)
            eh, em = divmod(em, 60)
            eta = f"{eh:d}:{em:02d}:{es:02d}" if eh else f"{em:02d}:{es:02d}"
        else:
            eta = "--:--"

        spin = _SPINNER[self._anim_i % len(_SPINNER)]
        # Wider bar on wide terminals
        bar_w = min(36, max(12, width - 24))
        filled = int(bar_w * min(done, self.total) / self.total) if self.total else 0
        if filled < bar_w and running > 0:
            tip = _PIPE_CHARS[self._pulse % len(_PIPE_CHARS)]
            bar = "█" * filled + tip + "░" * (bar_w - filled - 1)
        else:
            bar = "█" * filled + "░" * (bar_w - filled)

        mode = self.mode_label or "run"
        # Keep more of batch id on wide screens
        bid_keep = min(28, max(12, width - 28))
        bid = (self.batch_id or "-")[-bid_keep:]
        title = f" Grok Farm · {mode} · {bid} "
        lines: list[str] = []
        lines.append("╭" + title.center(width, "─")[:width] + "╮")
        lines.append(self._box(f"{bar}  {done:>4}/{self.total:<5} {pct:>3}% {spin}", width))
        lines.append(self._box(
            f"✓{self.ok:<5} ✗{self.fail:<5} ▶{running:<4}  "
            f"rate {rate:5.1f}/m  ETA {eta}  t {et}",
            width,
        ))
        # Free Build token quota (from probe headers on successful accounts)
        last_r = self.fmt_credits(self.credits_last_remaining)
        last_l = self.fmt_credits(self.credits_last_limit)
        sum_l = self.fmt_credits(self.credits_sum_limit if self.credits_accounts else None)
        n_cred = self.credits_accounts
        lines.append(self._box(
            f"credits  last {last_r}/{last_l}  ·  Σ limit {sum_l}  ·  "
            f"{n_cred} acct  (free Build tokens)",
            width,
        ))
        lines.append(self._box("pipeline  start○…●login●oauth●activate●probe", width))
        lines.append("│" + "─" * width + "│")

        workers = sorted(self._workers.values(), key=lambda x: x["attempt"])
        # Layout: "#NN " + email + "  " + spin + " " + step(9) + " " + "NNNs/NNNs!"
        # Reserve ~22 chars for #/spin/step/time; rest goes to email.
        reserved = 4 + 2 + 1 + 1 + 9 + 1 + 10  # #NN_  _spin_step_ times
        em_w = max(18, min(56, width - reserved - 2))
        # Detail line uses almost full width after indent + pipeline glyphs
        msg_w = max(24, width - 8)
        for i in range(self.WORKER_SLOTS):
            if i < len(workers):
                w = workers[i]
                age = int(now - w.get("step_t0", w.get("t0", now)))
                total = int(now - w.get("t0", now))
                em = _short_email(w.get("email") or "…", em_w)
                step = w.get("step") or ""
                label = self._step_label(step)
                msg = (w.get("message") or "").replace("\n", " ").strip()
                if w.get("email") and w.get("email") in msg:
                    msg = msg.replace(w.get("email") or "", "").strip(" -·")
                msg = self._fit(msg, msg_w) if msg else "…"
                pipe = self._pipeline(step)
                stuck = "!" if age >= 30 else ("·" if age >= 15 else " ")
                # Don't pad email with fixed width that wastes space on short emails
                lines.append(self._box(
                    f"#{w['attempt']:<3} {em}  {spin} {label:<9} "
                    f"{age:>3}s/{total}s{stuck}",
                    width,
                ))
                lines.append(self._box(f"     {pipe}  {msg}", width))
            elif i == 0 and not workers:
                lines.append(self._box(f"{spin} idle — waiting for next worker…", width))
                lines.append(self._box("", width))
            else:
                lines.append(self._box("", width))
                lines.append(self._box("", width))

        lines.append("│" + "─" * width + "│")
        recent_items = list(self._recent[-self.RECENT_SLOTS:]) if self._recent else []
        if not recent_items:
            lines.append(self._box("recent  —", width))
            for _ in range(self.RECENT_SLOTS - 1):
                lines.append(self._box("", width))
        else:
            pad = self.RECENT_SLOTS - len(recent_items)
            for _ in range(pad):
                lines.append(self._box("", width))
            for r in recent_items:
                # Full recent line width (was hard-cut to width-2 then boxed again)
                lines.append(self._box(r, width))

        if self.batch_dir:
            bd = self.batch_dir
            # Prefer showing the end of the path (batch folder name)
            max_bd = max(12, width - 6)
            if len(bd) > max_bd:
                bd = "…" + bd[-(max_bd - 1) :]
            lines.append(self._box(f"out  {bd}", width))
        else:
            lines.append(self._box("out  —", width))
        lines.append("╰" + "─" * width + "╯")
        lines.append(self._fit("  detail → farm.log  ·  Ctrl+C safe", width + 2).ljust(width + 2))
        while len(lines) < self.FRAME_HEIGHT:
            lines.append(" " * (width + 2))
        # Hard-cap every line — wrap is what stacks frames in Windows terminals
        max_len = width + 2
        return [
            (ln[:max_len] if len(ln) > max_len else ln.ljust(max_len)[:max_len])
            for ln in lines[: self.FRAME_HEIGHT]
        ]

    def render(self, force: bool = False) -> None:
        """Paint one HUD frame (ticker only under load). No stack / no spam."""
        if not self.enabled:
            return
        if self._painting and not force:
            return

        cols = self._term_cols()
        # Use almost the full terminal width (was capped at 72 → heavy truncation)
        paint_w = max(60, min(self.WIDTH, cols - 2))

        with self._slock:
            now = time.time()
            if not force and not self._dirty and (now - self._last_draw_t) < self.REDRAW_MIN_S:
                if not self._workers and self.ok + self.fail >= self.total:
                    return
            elapsed = int(now - self.started)
            worker_sig = tuple(
                (
                    a,
                    w.get("step"),
                    (w.get("message") or "")[:40],
                    int(now - w.get("step_t0", now)),
                )
                for a, w in sorted(self._workers.items())
            )
            sig = (
                self.ok, self.fail, worker_sig, elapsed, self.total,
                self.credits_accounts, self.credits_last_remaining,
                self.credits_sum_limit, self._anim_i, paint_w,
            )
            if sig == self._last_sig and not force and not self._dirty:
                return
            if not force and (now - self._last_draw_t) < self.REDRAW_MIN_S:
                return
            self._last_sig = sig
            self._last_draw_t = now
            self._dirty = False
            self._paint_width = paint_w
            lines = self._build_lines(paint_w)
            anim_i = self._anim_i
            ok, fail, total = self.ok, self.fail, self.total
            n_run = len(self._workers)
            prev_lines = self._drawn_lines
            started = self._started_draw

        out = self._real_stdout
        self._painting = True
        try:
            with self._io_lock:
                if not self._ansi_ok:
                    spin = _SPINNER[anim_i % len(_SPINNER)]
                    out.write(
                        f"\r  {spin} [{ok + fail}/{total}] ✓{ok} ✗{fail} "
                        f"▶{n_run}  {elapsed}s" + (" " * 16)
                    )
                    out.flush()
                    return
                parts: list[str] = []
                if started and prev_lines > 0:
                    parts.append(f"\033[{prev_lines}A")
                    parts.append("\033[J")  # erase leftovers below
                for line in lines:
                    parts.append("\033[2K\r")
                    parts.append(line)
                    parts.append("\n")
                out.write("".join(parts))
                out.flush()
                self._drawn_lines = len(lines)
                self._started_draw = True
        except Exception:
            self._started_draw = False
            self._drawn_lines = 0
        finally:
            self._painting = False

    async def ticker(self) -> None:
        """Sole regular HUD painter (~10 Hz)."""
        try:
            while True:
                await asyncio.sleep(self.TICK_S)
                if not self._active:
                    break
                with self._slock:
                    self._anim_i = (self._anim_i + 1) % len(_SPINNER)
                    self._pulse = (self._pulse + 1) % len(_PIPE_CHARS)
                    done = self.ok + self.fail >= self.total and not self._workers
                if done:
                    self._flush_log(force=True)
                    self.render(force=True)
                    break
                self._flush_log(force=False)
                self.render(force=True)
        except asyncio.CancelledError:
            return


HUD = FarmHUD()

# Quiet-print: while HUD is live, route builtins.print → farm.log only.
# Any console write mid-frame causes leftover stacked titles.
_ORIG_PRINT = None  # type: ignore[var-annotated]
_PRINT_PATCHED = False


def install_quiet_print() -> None:
    """Redirect print() to farm.log while HUD is active. Idempotent."""
    global _ORIG_PRINT, _PRINT_PATCHED
    if _PRINT_PATCHED:
        return
    import builtins
    _ORIG_PRINT = builtins.print

    def _quiet_print(*args, **kwargs):
        # force_console=True escapes mute (interrupt messages, fatal errors)
        force = bool(kwargs.pop("force_console", False))
        sep = kwargs.get("sep", " ")
        msg = sep.join(str(a) for a in args)
        if force or not HUD.enabled or not HUD._active or VERBOSE:
            if _ORIG_PRINT is not None:
                # I/O lock only — never take state lock (that froze HUD paint)
                with HUD._io_lock:
                    _ORIG_PRINT(*args, **{k: v for k, v in kwargs.items() if k != "force_console"})
            return
        HUD.log_line(msg)

    builtins.print = _quiet_print  # type: ignore[assignment]
    _PRINT_PATCHED = True


def restore_quiet_print() -> None:
    """Restore builtins.print after HUD run."""
    global _ORIG_PRINT, _PRINT_PATCHED
    if not _PRINT_PATCHED:
        return
    import builtins
    if _ORIG_PRINT is not None:
        builtins.print = _ORIG_PRINT  # type: ignore[assignment]
    _ORIG_PRINT = None
    _PRINT_PATCHED = False


def emit_progress(attempt: int, step: str, message: str, email_addr: str = "", **kwargs):
    email = email_addr or kwargs.get("email") or ""
    HUD.set_progress(attempt, step, message, email)
    if ETTEUM_FRAME_RELAY:
        _emit_etteum_json(
            {
                "type": "progress",
                "workerId": int(attempt),
                "step": step,
                "message": message,
                "email": email or f"worker #{attempt}",
            }
        )


def emit_success(attempt: int, email_addr: str, message: str):
    HUD.mark_ok(attempt, email_addr, message)
    if ETTEUM_FRAME_RELAY:
        _emit_etteum_json(
            {
                "type": "worker_done",
                "workerId": int(attempt),
                "ok": True,
                "email": email_addr or f"worker #{attempt}",
                "message": message,
            }
        )


def emit_failed(attempt: int, message: str, error: str = ""):
    HUD.mark_fail(attempt, message, error)
    if ETTEUM_FRAME_RELAY:
        _emit_etteum_json(
            {
                "type": "worker_done",
                "workerId": int(attempt),
                "ok": False,
                "email": f"worker #{attempt}",
                "message": message,
                "error": error or message,
            }
        )


def vlog(msg: str, attempt: int | None = None) -> None:
    """Verbose/debug line — always to farm.log; terminal only if log mode or VERBOSE."""
    prefix = f"[{attempt}] " if attempt is not None else ""
    HUD.log_line(prefix + msg)


async def _cancel_tasks_quiet(tasks: list, timeout: float = 2.0) -> None:
    """Cancel tasks and drain briefly. Avoids 'Task was destroyed pending' on Ctrl+C."""
    alive = [t for t in tasks if t is not None and not t.done()]
    for t in alive:
        t.cancel()
    if not alive:
        return
    try:
        await asyncio.wait_for(
            asyncio.gather(*alive, return_exceptions=True),
            timeout=timeout,
        )
    except (asyncio.TimeoutError, asyncio.CancelledError, Exception):
        pass


# ── Email uniqueness (crypto random + global used list across all batches) ───
_used_emails: set[str] = set()
_emails_lock = asyncio.Lock()
_ALPHANUM = string.ascii_lowercase + string.digits


def _crypto_local_part(length: int) -> str:
    """Cryptographically strong local-part: secrets, not random.choices."""
    return "".join(secrets.choice(_ALPHANUM) for _ in range(length))


def _emails_from_accounts_json(path: Path) -> set[str]:
    out: set[str] = set()
    if not path.is_file():
        return out
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            for row in data:
                if not isinstance(row, dict):
                    continue
                e = (row.get("email") or "").lower().strip()
                if e:
                    out.add(e)
    except Exception:
        pass
    return out


def _load_used_emails():
    """Load every email ever farmed: used_emails.txt + all batch/legacy results."""
    global _used_emails
    _used_emails = set()

    # Global index (authoritative across batches)
    if USED_EMAILS_FILE.is_file():
        try:
            for line in USED_EMAILS_FILE.read_text(encoding="utf-8").splitlines():
                e = line.strip().lower()
                if e and not e.startswith("#"):
                    _used_emails.add(e)
        except Exception as e:
            print(f"[DEDUP] Could not read {USED_EMAILS_FILE}: {e}", flush=True)

    # Legacy single file at results root
    _used_emails |= _emails_from_accounts_json(RESULTS_ROOT / "accounts.json")

    # Every batch folder
    if RESULTS_ROOT.is_dir():
        for batch in sorted(RESULTS_ROOT.glob("batch_*")):
            if batch.is_dir():
                _used_emails |= _emails_from_accounts_json(batch / "accounts.json")

    # Explicit legacy path override (if different)
    if _LEGACY_JSON:
        _used_emails |= _emails_from_accounts_json(Path(_LEGACY_JSON))

    print(f"[DEDUP] {len(_used_emails)} unique email(s) known across all batches", flush=True)


def _persist_used_email(email: str) -> None:
    """Append to global used_emails.txt so later batches never reuse it."""
    e = email.lower().strip()
    if not e:
        return
    USED_EMAILS_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(USED_EMAILS_FILE, "a", encoding="utf-8") as f:
        f.write(e + "\n")


def init_batch(max_accounts: int, concurrent: int) -> str:
    """Create a dedicated results folder for this run. Returns batch_id."""
    global BATCH_ID, BATCH_DIR, RESULTS_JSON, RESULTS_TXT, FAILED_JSON

    # Fixed paths if user forced legacy env vars
    if _LEGACY_JSON or _LEGACY_TXT or _LEGACY_FAILED:
        BATCH_ID = _env("GROK_BATCH_ID") or datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
        BATCH_DIR = RESULTS_ROOT
        RESULTS_JSON = Path(_LEGACY_JSON) if _LEGACY_JSON else RESULTS_ROOT / "accounts.json"
        RESULTS_TXT = Path(_LEGACY_TXT) if _LEGACY_TXT else RESULTS_ROOT / "accounts.txt"
        FAILED_JSON = Path(_LEGACY_FAILED) if _LEGACY_FAILED else RESULTS_ROOT / "failed.json"
        RESULTS_JSON.parent.mkdir(parents=True, exist_ok=True)
        _reset_results_memory()  # load existing if present
        print(f"[BATCH] legacy single-file mode batch_id={BATCH_ID}", flush=True)
        return BATCH_ID

    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    short = secrets.token_hex(3)
    BATCH_ID = _env("GROK_BATCH_ID") or f"{stamp}_{short}"
    # sanitize
    BATCH_ID = re.sub(r"[^a-zA-Z0-9_.-]", "_", BATCH_ID)[:80]
    BATCH_DIR = RESULTS_ROOT / f"batch_{BATCH_ID}"
    BATCH_DIR.mkdir(parents=True, exist_ok=True)
    RESULTS_JSON = BATCH_DIR / "accounts.json"
    RESULTS_TXT = BATCH_DIR / "accounts.txt"
    FAILED_JSON = BATCH_DIR / "failed.json"

    # empty batch files
    RESULTS_JSON.write_text("[]\n", encoding="utf-8")
    RESULTS_TXT.write_text("", encoding="utf-8")
    FAILED_JSON.write_text("[]\n", encoding="utf-8")
    # In-memory buffers for non-blocking concurrent saves
    _reset_results_memory([], [])
    meta = {
        "batch_id": BATCH_ID,
        "started_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "email_mode": EMAIL_MODE,
        "email_domain": EMAIL_DOMAIN if EMAIL_MODE == "domain" else None,
        "mail_mode": MAIL_MODE,
        "max_accounts": max_accounts,
        "concurrent": concurrent,
        "email_local_len": EMAIL_LOCAL_LEN,
    }
    (BATCH_DIR / "batch_meta.json").write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    print(f"[BATCH] id={BATCH_ID}", flush=True)
    print(f"[BATCH] dir={BATCH_DIR}", flush=True)
    return BATCH_ID


async def generate_email() -> str:
    """Crypto-random unique email; reserved in global set + used_emails.txt."""
    async with _emails_lock:
        for _ in range(200):
            if EMAIL_MODE == "domain":
                if not EMAIL_DOMAIN:
                    raise RuntimeError("GROK_EMAIL_DOMAIN required for domain mode")
                # secrets-based alnum (not random.choices) + global used set
                name = _crypto_local_part(EMAIL_LOCAL_LEN)
                addr = f"{name}@{EMAIL_DOMAIN.lstrip('@')}"
            else:
                base = GMAIL_BASE or IMAP_USER
                if not base or "@" not in base:
                    raise RuntimeError("GROK_GMAIL_BASE / GROK_IMAP_USER required for plus_trick")
                user, _, domain = base.partition("@")
                user = user.split("+", 1)[0]
                tag_len = max(10, min(20, EMAIL_LOCAL_LEN))
                tag = _crypto_local_part(tag_len)
                addr = f"{user}+{tag}@{domain}"
            key = addr.lower()
            if key not in _used_emails:
                _used_emails.add(key)
                _persist_used_email(key)  # reserve immediately so other processes / future batches skip
                return addr
    raise RuntimeError("Could not generate unique email after 200 attempts")


def random_name() -> tuple[str, str]:
    return random.choice(FIRST_NAMES), random.choice(LAST_NAMES)


# ── IMAP OTP ─────────────────────────────────────────────────────────────────
# xAI confirmation codes look like "K35-1QR" / "W0H-75T" (subject: "{CODE} xAI confirmation code")
_XAI_CODE_RE = re.compile(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", re.I)
# Subject almost always: "ABC-123 xAI confirmation code"
_XAI_SUBJ_CODE_RE = re.compile(
    r"^\s*([A-Z0-9]{3}-[A-Z0-9]{3})\s+xAI\s+confirmation", re.I
)
# Claimed OTPs across concurrent IMAP threads — one code per worker, never share
_claimed_otps_sync: set[str] = set()
_claimed_otps_lock = threading.Lock()


def _is_plausible_xai_otp(code: str) -> bool:
    """Accept real xAI codes; reject CSS noise (PER-100, RGB-255, PX-16).

    xAI codes are XXX-XXX alnum — often mixed (Y34-FHY) but ALSO pure alpha (WGJ-HKA).
    Do NOT require a digit.
    """
    code = (code or "").upper().strip()
    if not re.fullmatch(r"[A-Z0-9]{3}-[A-Z0-9]{3}", code):
        return False
    left, right = code.split("-", 1)
    # CSS-ish: all-alpha left + all-digit right (PER-100, EM-16) — reject
    if re.fullmatch(r"[A-Z]+", left) and re.fullmatch(r"\d+", right):
        return False
    # all-digit both sides unlikely for xAI (and CSS-ish)
    if re.fullmatch(r"\d+", left) and re.fullmatch(r"\d+", right):
        return False
    if code in {"PER-100", "RGB-255", "PX-16", "EM-16", "REM-16", "MS-300", "MS-200"}:
        return False
    return True


def _extract_xai_code(subject: str, body: str) -> str | None:
    # 1) Prefer subject line — authoritative for xAI
    m = _XAI_SUBJ_CODE_RE.search(subject or "")
    if m:
        code = m.group(1).upper()
        if _is_plausible_xai_otp(code):
            return code
    # 2) Any XXX-XXX in subject
    for m in _XAI_CODE_RE.finditer(subject or ""):
        code = m.group(1).upper()
        if _is_plausible_xai_otp(code):
            return code
    # 3) Body plain-text only (strip style/script to avoid CSS PER-100 etc.)
    plain = body or ""
    plain = re.sub(r"<style[\s\S]*?</style>", " ", plain, flags=re.I)
    plain = re.sub(r"<script[\s\S]*?</script>", " ", plain, flags=re.I)
    plain = re.sub(r"<[^>]+>", " ", plain)
    for m in _XAI_CODE_RE.finditer(plain):
        code = m.group(1).upper()
        if _is_plausible_xai_otp(code):
            return code
    # Fallback 6-digit (unlikely for xAI but keep)
    m = re.search(r"\b(\d{6})\b", plain)
    return m.group(1) if m else None


def read_otp_from_imap_sync(target_email: str, timeout: int = 180, since_ts: float | None = None) -> str | None:
    """Poll Gmail IMAP for xAI confirmation code addressed to target_email.

    Codes arrive from noreply@x.ai with subject like "K35-1QR xAI confirmation code".
    Catch-all domains forward into this inbox; match To/Delivered-To/body for the alias.
    Concurrent workers: each OTP code is claimed once (no double-use of same mail).
    """
    print(f"[IMAP] Waiting for xAI OTP to {target_email}...", flush=True)
    start = time.time()
    since_ts = since_ts or (start - 30)
    target_lower = target_email.lower()
    target_local = target_lower.split("@")[0]
    seen_uids: set[bytes] = set()

    while time.time() - start < timeout:
        try:
            mail = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
            mail.login(IMAP_USER, IMAP_PASS)
            mail.select("INBOX")
            status, messages = mail.search(None, '(FROM "x.ai")')
            msg_ids = messages[0].split() if messages and messages[0] else []
            if not msg_ids:
                status, messages = mail.search(None, '(SUBJECT "confirmation code")')
                msg_ids = messages[0].split() if messages and messages[0] else []

            for mid in reversed(msg_ids[-40:]):
                if mid in seen_uids:
                    continue
                status, data = mail.fetch(mid, "(RFC822)")
                if not data or not data[0]:
                    continue
                msg = message_from_bytes(data[0][1])
                subject = msg.get("Subject", "") or ""
                to_addr = " ".join(
                    filter(
                        None,
                        [
                            msg.get("To", ""),
                            msg.get("Delivered-To", ""),
                            msg.get("X-Original-To", ""),
                            msg.get("Cc", ""),
                        ],
                    )
                ).lower()

                body = ""
                if msg.is_multipart():
                    for part in msg.walk():
                        ct = part.get_content_type()
                        if ct == "text/plain":
                            try:
                                body = part.get_payload(decode=True).decode("utf-8", "replace")
                            except Exception:
                                body = ""
                            if body:
                                break
                        if ct == "text/html" and not body:
                            try:
                                body = part.get_payload(decode=True).decode("utf-8", "replace")
                            except Exception:
                                body = ""
                else:
                    try:
                        body = msg.get_payload(decode=True).decode("utf-8", "replace")
                    except Exception:
                        body = str(msg.get_payload() or "")

                # Match recipient (catch-all alias, plus-trick, or body mention)
                # Prefer header match; body match only if subject is clearly xAI confirmation
                header_hit = target_lower in to_addr or target_local in to_addr
                body_l = body.lower()
                body_hit = target_lower in body_l or (
                    len(target_local) >= 8 and target_local in body_l
                )
                subj_is_xai = bool(_XAI_SUBJ_CODE_RE.search(subject) or re.search(
                    r"xAI\s+confirmation", subject or "", re.I
                ))
                if not header_hit and not (body_hit and subj_is_xai):
                    seen_uids.add(mid)
                    continue

                code = _extract_xai_code(subject, body)
                if code:
                    # Concurrent: claim code once so two workers don't take same OTP
                    with _claimed_otps_lock:
                        if code in _claimed_otps_sync:
                            seen_uids.add(mid)
                            continue
                        _claimed_otps_sync.add(code)
                    print(f"[IMAP] Found OTP: {code} for {target_email} (subj={subject[:60]!r})", flush=True)
                    try:
                        mail.store(mid, "+FLAGS", "\\Seen")
                    except Exception:
                        pass
                    mail.logout()
                    return code
                seen_uids.add(mid)
            mail.logout()
        except Exception as e:
            print(f"[IMAP] Error: {e}", flush=True)
        time.sleep(4)
    print("[IMAP] Timeout waiting for OTP", flush=True)
    return None


# ── Vision CAPTCHA (interactive Turnstile puzzles) ───────────────────────────
def _resolve_captcha_api_key() -> str:
    return CAPTCHA_API_KEY or ""


def _call_vision_model(image_b64: str, prompt: str, timeout: int = 60) -> str | None:
    if not CAPTCHA_PROXY_URL:
        return None
    api_key = _resolve_captcha_api_key()
    if not api_key:
        print("[CAPTCHA] No API key for vision model", flush=True)
        return None
    payload = {
        "model": CAPTCHA_MODEL,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/png;base64,{image_b64}"},
                    },
                ],
            }
        ],
        "max_tokens": 512,
        "temperature": 0,
    }
    req = urllib.request.Request(
        CAPTCHA_PROXY_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            return (
                data.get("choices", [{}])[0]
                .get("message", {})
                .get("content", "")
            )
    except Exception as e:
        print(f"[CAPTCHA] Vision error: {e}", flush=True)
        return None


_VISION_TURNSTILE_PROMPT = """You are looking at a browser screenshot that may show a Cloudflare Turnstile
interactive challenge (image selection puzzle, not a simple checkbox).

If you see a visual challenge (select all images with X, click objects, etc.):
1. Identify the tiles/objects to click
2. Return click coordinates as percentages of the FULL PAGE screenshot:
   CLICK: x1%,y1% | x2%,y2% | ...
   where x and y are 0-100 relative to the full image.

If only a simple "Verify you are human" checkbox is visible:
  return exactly: CHECKBOX

If no captcha/challenge is visible:
  return exactly: NO_CAPTCHA

Do not invent coordinates for form fields."""


def _parse_vision_clicks(text: str) -> list[tuple[float, float]] | None:
    if not text:
        return None
    upper = text.strip().upper()
    if "NO_CAPTCHA" in upper or "CHECKBOX" in upper:
        return None
    clicks = []
    for m in re.finditer(r"(\d{1,3}(?:\.\d+)?)\s*%\s*[, ]\s*(\d{1,3}(?:\.\d+)?)\s*%", text):
        x, y = float(m.group(1)), float(m.group(2))
        if 0 <= x <= 100 and 0 <= y <= 100:
            clicks.append((x, y))
    return clicks or None


# ── Browser cleanup hardening (Camoufox / Playwright) ───────────────────────
# Process tree (probed on Windows):
#   python → node.exe (Playwright driver) → camoufox.exe → camoufox children
# Driver PID: manager._connection._transport._proc.pid
# Temp dirs created at launch (must clean on crash):
#   %TEMP%/playwright_firefoxdev_profile-*
#   %TEMP%/playwright-artifacts-*
#
# Every launch is registered with: manager, driver PID, and owned temp profile
# dirs. Cleanup is STRICTLY per-browser: kill only that driver PID tree, delete
# only that browser's claimed profiles. Never touch another live worker.
#
# CRITICAL: concurrent launches must not claim each other's temp dirs (race
# caused "Connection closed" when worker A deleted worker B's profile).
_BROWSER_LOCK = threading.Lock()
# Each entry: {
#   "manager": AsyncCamoufox,
#   "driver_pid": int|None,
#   "tree_pids": set[int],
#   "profiles": set[str],
#   "launched_at": float,
# }
_tracked_browsers: list[dict[str, Any]] = []
_owned_profiles: set[str] = set()          # union of all live owned profiles
_tracked_driver_pids: set[int] = set()     # live driver PIDs (kill allow-list)
_CLEANUP_DONE = False
_ATEXIT_REGISTERED = False
# Serialize launch ownership snapshot so two browsers never claim the same temps
_launch_lock: asyncio.Lock | None = None
_launch_sem: asyncio.Semaphore | None = None


def _get_launch_sem() -> asyncio.Semaphore:
    """Limit simultaneous Camoufox process boots (network/CPU storm guard)."""
    global _launch_sem
    if _launch_sem is None:
        _launch_sem = asyncio.Semaphore(LAUNCH_PARALLEL)
    return _launch_sem


def effective_spawn_delay(concurrent: int) -> float:
    """Stagger worker *starts* under load so page-loads don't all hit the wire at once.

    - If GROK_SPAWN_DELAY > 0 → use it.
    - Else if AUTO_STAGGER and concurrent >= 3 → GROK_AUTO_SPAWN_DELAY (default 2s).
    - Else 0.
    """
    if SPAWN_DELAY > 0:
        return SPAWN_DELAY
    if AUTO_STAGGER and concurrent >= 3 and AUTO_SPAWN_DELAY_S > 0:
        return AUTO_SPAWN_DELAY_S
    return 0.0


def _driver_pid(manager) -> int | None:
    """Extract the Playwright node-driver PID from an AsyncCamoufox manager."""
    try:
        proc = manager._connection._transport._proc
        return getattr(proc, "pid", None)
    except Exception:
        return None


def _rmtree_retry(path: str, retries: int = 3, delay: float = 0.7) -> bool:
    """rmtree with retries — Windows holds file locks briefly after process kill."""
    for _ in range(retries):
        try:
            if not os.path.exists(path):
                return True
            shutil.rmtree(path, ignore_errors=False)
            return True
        except FileNotFoundError:
            return True
        except Exception:
            time.sleep(delay)
    shutil.rmtree(path, ignore_errors=True)
    return not os.path.exists(path)


def _temp_profile_patterns() -> list[str]:
    """Glob patterns for Camoufox/Playwright temp dirs under OS temp."""
    td = tempfile.gettempdir()
    return [
        os.path.join(td, "playwright_firefoxdev_profile-*"),
        os.path.join(td, "playwright-artifacts-*"),
        os.path.join(td, "camoufox-*"),
        os.path.join(td, "rust_mozprofile*"),
        os.path.join(td, "firefox_*"),
    ]


def _snapshot_temp_profiles() -> set[str]:
    """Snapshot known Playwright/Camoufox temp paths currently on disk."""
    found: set[str] = set()
    for pat in _temp_profile_patterns():
        for d in glob.glob(pat):
            found.add(os.path.abspath(d))
    # mozilla scratch folder (sometimes used)
    mt = os.path.join(tempfile.gettempdir(), "mozilla-temp-files")
    if os.path.isdir(mt):
        try:
            for name in os.listdir(mt):
                found.add(os.path.abspath(os.path.join(mt, name)))
        except Exception:
            pass
    return found


def _collect_process_tree(root_pid: int) -> set[int]:
    """Optional deep tree walk — NEVER call on the event-loop hot path.

    Prefer taskkill /T (Windows) which kills the whole tree from the driver
    PID without enumerating processes (enumeration via PowerShell WMI was
    causing ~1s HUD freezes at every browser launch).
    """
    if not root_pid:
        return set()
    return {int(root_pid)}


def _pid_alive(pid: int) -> bool:
    """Fast PID liveness check (no tasklist / PowerShell)."""
    if not pid:
        return False
    try:
        if sys.platform == "win32":
            import ctypes
            k32 = ctypes.windll.kernel32
            # PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            h = k32.OpenProcess(0x1000, 0, int(pid))
            if h:
                k32.CloseHandle(h)
                return True
            return False
        os.kill(int(pid), 0)
        return True
    except Exception:
        return False


def startup_profile_sweep() -> int:
    """Delete orphan Camoufox/Playwright temp dirs from prior crashed runs."""
    removed = 0
    for path in sorted(_snapshot_temp_profiles()):
        if _rmtree_retry(path, retries=2, delay=0.3):
            removed += 1
    if removed:
        print(
            f"[cleanup] startup sweep removed {removed} orphan temp profile path(s)",
            flush=True,
        )
    return removed


def _kill_pid_tree(pid: int, *, allow_untracked: bool = False) -> list[int]:
    """Force-kill ONE driver PID + its process tree only.

    Safety: by default refuses to kill a PID that is not (or was not just)
    associated with our farm, unless allow_untracked=True (session teardown
    after untrack, or explicit close of that browser's own driver).
    """
    if not pid:
        return []
    pid = int(pid)
    try:
        if sys.platform == "win32":
            # /T = only the tree rooted at THIS pid (not other node/camoufox)
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                timeout=10,
            )
        else:
            try:
                out = subprocess.run(
                    ["pgrep", "-P", str(pid)],
                    capture_output=True,
                    text=True,
                    timeout=3,
                ).stdout
                for tok in out.split():
                    try:
                        os.kill(int(tok), signal.SIGKILL)
                    except (ProcessLookupError, PermissionError, ValueError):
                        pass
            except Exception:
                pass
            try:
                os.kill(pid, signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                pass
    except subprocess.TimeoutExpired:
        pass
    except Exception as e:
        print(f"[cleanup] kill tree {pid} failed: {e}", flush=True)
    return [pid]


def _track_browser(manager, profiles: set[str] | None = None) -> dict[str, Any]:
    """Register launched browser. Hot-path safe: no sleep, no process scan.

    profiles must already be exclusive to this browser (launch lock claims them).
    """
    global _tracked_driver_pids
    driver = _driver_pid(manager)
    tree = {int(driver)} if driver else set()
    profs = {os.path.abspath(p) for p in (profiles or set()) if p}
    entry: dict[str, Any] = {
        "manager": manager,
        "driver_pid": driver,
        "tree_pids": set(tree),
        "profiles": profs,
        "launched_at": time.time(),
    }
    with _BROWSER_LOCK:
        # Never claim a profile another live browser already owns
        conflict = profs & _owned_profiles
        if conflict:
            profs -= _owned_profiles
            entry["profiles"] = profs
            print(
                f"[cleanup] WARN profile claim conflict dropped={sorted(conflict)[:3]}",
                flush=True,
            )
        if driver and driver in _tracked_driver_pids:
            print(
                f"[cleanup] WARN driver_pid={driver} already tracked — "
                f"will still register (check for shared driver)",
                flush=True,
            )
        _tracked_browsers.append(entry)
        _owned_profiles.update(profs)
        if driver:
            _tracked_driver_pids.add(int(driver))
    print(
        f"[cleanup] track browser driver_pid={driver} profiles={len(profs)}",
        flush=True,
    )
    return entry


def _untrack_browser(manager) -> dict[str, Any] | None:
    """Remove a browser from tracking after close. Returns the entry if found."""
    global _tracked_driver_pids
    with _BROWSER_LOCK:
        for i, ent in enumerate(_tracked_browsers):
            if ent.get("manager") is manager:
                removed = _tracked_browsers.pop(i)
                for p in removed.get("profiles") or []:
                    _owned_profiles.discard(p)
                d = removed.get("driver_pid")
                if d:
                    _tracked_driver_pids.discard(int(d))
                return removed
    return None


def _profiles_owned_by_others(exclude_paths: set[str] | None = None) -> set[str]:
    """Paths still claimed by any currently tracked browser."""
    with _BROWSER_LOCK:
        out: set[str] = set()
        for ent in _tracked_browsers:
            out |= set(ent.get("profiles") or set())
        if exclude_paths:
            # exclude_paths are the ones WE are about to delete (already untracked)
            pass
        return out


def _remove_profile_dirs(
    paths: set[str] | list[str],
    *,
    label: str = "",
    respect_others: bool = True,
) -> int:
    """Delete temp profile dirs. If respect_others, skip paths still owned live."""
    skip: set[str] = set()
    if respect_others:
        skip = _profiles_owned_by_others()
    removed = 0
    for p in sorted(set(paths or [])):
        if not p:
            continue
        ap = os.path.abspath(p)
        if respect_others and ap in skip:
            print(
                f"[cleanup] skip profile still owned by another browser: {ap}",
                flush=True,
            )
            continue
        if _rmtree_retry(ap, retries=3, delay=0.4):
            removed += 1
            print(
                f"[cleanup] removed temp profile{(' ' + label) if label else ''}: {ap}",
                flush=True,
            )
    return removed


def _force_kill_all_browsers_sync() -> dict[str, Any]:
    """Session end only: kill every tracked browser + sweep their temps.

    Never call mid-run for a single worker — that would kill siblings.
    """
    global _tracked_driver_pids
    with _BROWSER_LOCK:
        entries = list(_tracked_browsers)
        _tracked_browsers.clear()
        owned = set(_owned_profiles)
        _owned_profiles.clear()
        _tracked_driver_pids.clear()

    killed_roots: list[int] = []
    killed_all: set[int] = set()
    for ent in entries:
        driver = ent.get("driver_pid")
        if driver:
            for p in _kill_pid_tree(int(driver), allow_untracked=True):
                killed_all.add(p)
            killed_roots.append(int(driver))
        owned |= set(ent.get("profiles") or set())

    if sys.platform == "win32" and killed_all:
        time.sleep(0.4)

    # Only our owned profiles + leftover globs AFTER all workers are dead
    removed = _remove_profile_dirs(owned, label="owned", respect_others=False)
    orphan_paths = _snapshot_temp_profiles()
    if orphan_paths:
        removed += _remove_profile_dirs(
            orphan_paths, label="orphan", respect_others=False
        )

    still_alive = [p for p in sorted(killed_all) if _pid_alive(p)]
    report = {
        "killed_roots": killed_roots,
        "killed_pids": sorted(killed_all),
        "still_alive": still_alive,
        "profiles_removed": removed,
        "entries": len(entries),
    }
    return report


def session_cleanup(reason: str = "exit", *, quiet: bool = False) -> dict[str, Any]:
    """Full session teardown: kill browsers, remove temp profiles, log report.

    Call on: normal finish, Ctrl+C finally, atexit. Safe to call multiple times.
    """
    global _CLEANUP_DONE
    if _CLEANUP_DONE and not _tracked_browsers and not _owned_profiles:
        return {"skipped": True, "reason": reason}
    report = _force_kill_all_browsers_sync()
    _CLEANUP_DONE = True
    if not quiet:
        roots = report.get("killed_roots") or []
        pids = report.get("killed_pids") or []
        alive = report.get("still_alive") or []
        removed = report.get("profiles_removed") or 0
        n = report.get("entries") or 0
        print(
            f"[cleanup] session end ({reason}): browsers={n} "
            f"driver_pids={roots} tree_pids={len(pids)} "
            f"profiles_removed={removed}"
            + (f" STILL_ALIVE={alive}" if alive else " clean"),
            flush=True,
        )
    return report


def _register_atexit_cleanup() -> None:
    """Ensure process exit always runs session_cleanup (even if finally missed)."""
    global _ATEXIT_REGISTERED
    if _ATEXIT_REGISTERED:
        return
    import atexit

    def _on_exit() -> None:
        try:
            session_cleanup("atexit", quiet=False)
        except Exception:
            try:
                _force_kill_all_browsers_sync()
            except Exception:
                pass

    atexit.register(_on_exit)
    _ATEXIT_REGISTERED = True


_SIGINT_HITS = 0


def _install_sigint_handler() -> None:
    """Install a sync SIGINT handler that force-kills browsers even with no loop.

    On Windows, loop.add_signal_handler doesn't work for SIGINT, so signal.signal
    is the only way to guarantee cleanup on Ctrl+C. The handler must be minimal
    and sync (no awaiting). This is a backstop behind asyncio's KeyboardInterrupt.

    First Ctrl+C: kill browsers + raise KeyboardInterrupt so finally blocks run.
    Second Ctrl+C: hard exit (os._exit) if still stuck mid-Playwright cancel.
    """
    _register_atexit_cleanup()

    def on_sigint(signum, frame):
        global _SIGINT_HITS
        _SIGINT_HITS += 1
        try:
            session_cleanup("sigint", quiet=False)
        except Exception:
            try:
                _force_kill_all_browsers_sync()
            except Exception:
                pass
        if _SIGINT_HITS >= 2:
            try:
                restore_quiet_print()
            except Exception:
                pass
            try:
                sys.stderr.write("\n[force exit after cleanup]\n")
                sys.stderr.flush()
            except Exception:
                pass
            os._exit(130)
        raise KeyboardInterrupt

    try:
        signal.signal(signal.SIGINT, on_sigint)
    except (ValueError, OSError):
        pass
    # SIGTERM (POSIX service stop / kill) — best-effort same cleanup
    if hasattr(signal, "SIGTERM"):
        try:
            signal.signal(signal.SIGTERM, on_sigint)
        except (ValueError, OSError):
            pass


# ── Temp-mail domain blacklist (self-healing) ───────────────────────────────
# xAI bans some temp-mail subdomains ("Your email domain X has been rejected").
# We detect that, add the domain here, and re-roll a fresh temp-mail address.
class DomainRejectedError(RuntimeError):
    """xAI rejected the email's domain. Carries the rejected domain."""
    def __init__(self, domain: str, message: str = ""):
        self.domain = domain
        super().__init__(message or f"email domain rejected by xAI: {domain}")


class RecoverableFarmError(RuntimeError):
    """Transient UI/browser/CF failure — retry with fresh browser (+ new email).

    Not a permanent account fail. Caller closes browsers and loops.
    """
    def __init__(self, message: str, *, delay_s: float = 2.0, tag: str = "Recoverable"):
        self.delay_s = float(delay_s)
        self.tag = tag
        super().__init__(message)


def _is_recoverable_error(err: BaseException | str) -> bool:
    """True if this failure should re-spawn browser instead of permanent fail."""
    if isinstance(err, RecoverableFarmError):
        return True
    if isinstance(err, DomainRejectedError):
        return False
    if isinstance(err, asyncio.TimeoutError):
        return True
    msg = str(err).lower()
    needles = (
        "could not find email input",
        "failed to fill email",
        "otp input never appeared",
        "otp timeout",
        "otp rejected",
        "fill_otp hung",
        "tempmail",
        "generator.email",
        "complete_signup stuck",
        "activate_grok_com failed",
        "page load error",
        "couldn't load",
        "connection closed",
        "target closed",
        "browser/driver died",
        "browsercrash",
        "timeout",
        "navigation failed",
        "net::",
        "ns_error",
        "execution context was destroyed",
        "frame was detached",
        "protocol error",
        "oauth code not captured",
        "oauth succeeded but access_token missing",
        "token exchange",
        "invalid_grant",
        "http 400",
        "bad request",
        "activatefail",
        "activate_grok",
    )
    return any(n in msg for n in needles)


_BLACKLIST_LOCK = threading.Lock()
_blacklist_cache: set[str] | None = None  # None = not loaded yet


def blacklist_load() -> set[str]:
    """Load blacklisted domains into the cache (thread-safe, load once)."""
    global _blacklist_cache
    with _BLACKLIST_LOCK:
        if _blacklist_cache is None:
            domains: set[str] = set()
            if BLACKLIST_FILE.is_file():
                try:
                    for line in BLACKLIST_FILE.read_text(encoding="utf-8").splitlines():
                        d = line.strip().lower().lstrip("@")
                        if d:
                            domains.add(d)
                except Exception:
                    pass
            _blacklist_cache = domains
        return _blacklist_cache


def blacklist_add(domain: str) -> bool:
    """Add a domain to the blacklist (cache + file). Returns True if newly added."""
    if not domain:
        return False
    domain = domain.strip().lower().lstrip("@")
    bl = blacklist_load()
    with _BLACKLIST_LOCK:
        if domain in bl:
            return False
        bl.add(domain)
    # append to file (one domain per line)
    try:
        with open(BLACKLIST_FILE, "a", encoding="utf-8") as f:
            f.write(domain + "\n")
    except Exception as e:
        print(f"[blacklist] failed to write {domain}: {e}", flush=True)
    print(f"[blacklist] added rejected domain: {domain}", flush=True)
    return True


def blacklist_contains(domain: str) -> bool:
    """True if the domain (or any parent) is blacklisted."""
    if not domain:
        return False
    domain = domain.strip().lower().lstrip("@")
    bl = blacklist_load()
    if domain in bl:
        return True
    # also match parent domains (e.g. blacklisted "mailfly.com" rejects a@b.mailfly.com)
    parts = domain.split(".")
    for i in range(1, len(parts) - 1):
        if ".".join(parts[i:]) in bl:
            return True
    return False


def email_domain(email: str) -> str:
    """Extract domain from an email address (lowercased, no @)."""
    if not email or "@" not in email:
        return ""
    return email.rsplit("@", 1)[-1].strip().lower().lstrip("@")


def get_grok_cli_version() -> str:
    """Resolve x-grok-client-version. Cached; never stall workers (≤2s fetch)."""
    global _CLI_VERSION_CACHE
    if _CLI_VERSION_CACHE:
        return _CLI_VERSION_CACHE
    try:
        with urllib.request.urlopen(CLI_VERSION_URL, timeout=2) as resp:
            v = (resp.read().decode("utf-8", errors="replace") or "").strip()
        if re.match(r"^\d+\.\d+\.\d+$", v):
            _CLI_VERSION_CACHE = v
            return v
    except Exception:
        pass
    _CLI_VERSION_CACHE = CLI_VERSION_FALLBACK
    return CLI_VERSION_FALLBACK


def decode_access_jwt_claims(access_token: str) -> dict[str, Any]:
    """Decode OIDC access JWT payload (no verify) for diagnostics."""
    try:
        parts = (access_token or "").split(".")
        if len(parts) < 2:
            return {}
        payload_b64 = parts[1] + "=" * (-len(parts[1]) % 4)
        return json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
    except Exception:
        return {}


def _claim_bits(access_token: str) -> list[str]:
    claims = decode_access_jwt_claims(access_token)
    bits: list[str] = []
    if claims.get("tier") is not None:
        bits.append(f"tier={claims.get('tier')}")
    if claims.get("scope"):
        sc = str(claims.get("scope"))
        bits.append(
            "scopes=ok" if "grok-cli:access" in sc else f"scopes_missing_cli={sc[:40]}"
        )
    if claims.get("sub"):
        bits.append(f"sub={str(claims.get('sub'))[:8]}…")
    return bits


def _parse_rate_limit_credits(headers) -> dict[str, Any]:
    """Extract free Build token quota from response headers (refer-compatible)."""
    out: dict[str, Any] = {
        "credits_remaining": None,
        "credits_limit": None,
        "req_remaining": None,
        "model": None,
    }
    if headers is None:
        return out
    try:
        rem = headers.get("x-ratelimit-remaining-tokens")
        lim = headers.get("x-ratelimit-limit-tokens")
        rrem = headers.get("x-ratelimit-remaining-requests")
        if rem is not None and str(rem).strip() != "":
            out["credits_remaining"] = float(rem)
        if lim is not None and str(lim).strip() != "":
            out["credits_limit"] = float(lim)
        if rrem is not None and str(rrem).strip() != "":
            out["req_remaining"] = float(rrem)
    except Exception:
        pass
    return out


def _rate_limit_bits(credits: dict[str, Any]) -> list[str]:
    """Format credits dict into probe detail bits."""
    bits: list[str] = []
    if credits.get("credits_remaining") is not None:
        bits.append(f"credits_remaining={int(credits['credits_remaining'])}")
    if credits.get("credits_limit") is not None:
        bits.append(f"credits_limit={int(credits['credits_limit'])}")
    if credits.get("req_remaining") is not None:
        bits.append(f"req_remaining={int(credits['req_remaining'])}")
    return bits


def _probe_one(
    url: str,
    body: dict,
    headers: dict[str, str],
    *,
    label: str,
    claim_bits: list[str],
    content_extractor: Callable[[dict, str], str],
) -> tuple[bool, int, str, dict[str, Any]]:
    """Single POST probe. Blocking. Returns (ok, status, detail, credits)."""
    empty_c: dict[str, Any] = {
        "credits_remaining": None,
        "credits_limit": None,
        "req_remaining": None,
        "model": None,
    }
    t0 = time.monotonic()
    raw_body = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        url, data=raw_body, headers=headers, method="POST",
    )
    try:
        # Keep probe snappy so HUD workers don't sit on "POST responses" for 60s
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
            code = int(getattr(resp, "status", 200) or 200)
            ms = int((time.monotonic() - t0) * 1000)
            credits = _parse_rate_limit_credits(getattr(resp, "headers", None))
            content_preview = ""
            model = ""
            try:
                parsed = json.loads(raw) if raw else {}
                if isinstance(parsed, dict):
                    model = str(parsed.get("model") or "")
                    content_preview = content_extractor(parsed, raw)[:40]
            except Exception:
                pass
            if model:
                credits["model"] = model
            bits = [
                f"HTTP {code} in {ms}ms",
                f"via={label}",
                "ACCESS Bearer",
            ]
            bits.extend(claim_bits)
            bits.extend(_rate_limit_bits(credits))
            if model:
                bits.append(f"model={model}")
            if content_preview:
                bits.append(f"content={content_preview!r}")
            bits.append(f"bytes={len(raw)}")
            if code == 200:
                return True, code, " ".join(bits), credits
            return False, code, " ".join(bits) + f" body={raw[:120]}", credits
    except urllib.error.HTTPError as e:
        try:
            raw = e.read().decode("utf-8", errors="replace")
        except Exception:
            raw = ""
        ms = int((time.monotonic() - t0) * 1000)
        credits = _parse_rate_limit_credits(getattr(e, "headers", None))
        bits = [
            f"HTTP {int(e.code or 0)} in {ms}ms",
            f"via={label}",
            "ACCESS Bearer",
        ]
        bits.extend(claim_bits)
        bits.extend(_rate_limit_bits(credits))
        return False, int(e.code or 0), " ".join(bits) + f" body={raw[:160]}", credits
    except Exception as e:
        ms = int((time.monotonic() - t0) * 1000)
        return False, 0, f"probe network error after {ms}ms via={label}: {e}", empty_c


def probe_cli_chat(
    access_token: str,
    version: str | None = None,
) -> tuple[bool, int, str, dict[str, Any]]:
    """CLI smoke: POST /v1/responses model=grok-4.5 only.

    Returns (ok, status, detail, credits) where credits has
    credits_remaining / credits_limit (free Build quota tokens).

    Blocking — call via ``await _run_io(probe_cli_chat, …)``.
    """
    empty_c: dict[str, Any] = {
        "credits_remaining": None,
        "credits_limit": None,
        "req_remaining": None,
        "model": None,
    }
    if not access_token:
        return False, 0, "missing access_token", empty_c
    version = version or get_grok_cli_version()
    claims = _claim_bits(access_token)

    def _extract_responses(parsed: dict, raw: str) -> str:
        content = ""
        for item in parsed.get("output") or []:
            if not isinstance(item, dict):
                continue
            if item.get("type") == "message":
                for c in item.get("content") or []:
                    if isinstance(c, dict) and c.get("type") in ("output_text", "text"):
                        content += c.get("text") or ""
        if not content and isinstance(parsed.get("output_text"), str):
            content = parsed["output_text"]
        return content or raw[:40]

    # Headers match refer/grok-farm-refer smoke_test_cli_access exactly
    # (no User-Agent — refer omits it; model=grok-4.5 Responses only).
    ver = version or CLI_VERSION_FALLBACK
    return _probe_one(
        CLI_RESPONSES_URL,
        {
            "model": CLI_PROBE_MODEL,
            "input": "Reply with exactly: OK",
            "stream": False,
            "max_output_tokens": 16,
        },
        {
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "x-grok-client-version": ver,
            "x-grok-client-identifier": "grok-build",
            "x-grok-client-surface": "grok-build",
        },
        label=f"responses/{CLI_PROBE_MODEL}",
        claim_bits=claims,
        content_extractor=_extract_responses,
    )


async def run_chat_probe_with_hud(
    attempt: int,
    email_addr: str,
    access_token: str,
    *,
    context: str = "farm",
) -> tuple[bool, int, str, dict[str, Any]]:
    """HUD-friendly grok-4.5 Responses probe. Returns (ok, status, detail, credits)."""
    at = (access_token or "").strip()
    at_preview = f"{at[:10]}…{at[-6:]}" if len(at) > 20 else (at[:16] or "(empty)")
    domain = email_domain(email_addr) or "?"
    empty_c: dict[str, Any] = {
        "credits_remaining": None,
        "credits_limit": None,
        "req_remaining": None,
        "model": None,
    }

    emit_progress(
        attempt,
        "chat_probe",
        f"[{context}] auth=ACCESS Bearer {at_preview}  (not refresh)",
        email_addr,
    )
    await asyncio.sleep(0)

    # Version is local/cache-first (≤2s network); don't stall HUD on x.ai
    version = await _run_io(get_grok_cli_version)
    await asyncio.sleep(0)

    emit_progress(
        attempt,
        "chat_probe",
        f"[{context}] POST {CLI_PROBE_MODEL} (≤15s) cli={version}",
        email_addr,
    )
    vlog(
        f"chat_probe: {CLI_RESPONSES_URL} model={CLI_PROBE_MODEL} "
        f"surface=grok-build token_len={len(at)} preview={at_preview} "
        f"cli={version} domain={domain}",
        attempt,
    )
    t_wait = time.monotonic()
    result = await _run_io(probe_cli_chat, at, version)
    if not isinstance(result, tuple) or len(result) < 3:
        ok, status, detail, credits = False, 0, "bad probe result", empty_c
    elif len(result) == 3:
        ok, status, detail = result  # type: ignore[misc]
        credits = empty_c
    else:
        ok, status, detail, credits = result  # type: ignore[misc]
    wait_ms = int((time.monotonic() - t_wait) * 1000)
    await asyncio.sleep(0)

    rem = credits.get("credits_remaining") if isinstance(credits, dict) else None
    lim = credits.get("credits_limit") if isinstance(credits, dict) else None
    model = (credits.get("model") if isinstance(credits, dict) else None) or CLI_PROBE_MODEL
    cred_s = ""
    if rem is not None or lim is not None:
        cred_s = (
            f"  credits {FarmHUD.fmt_credits(rem)}/"
            f"{FarmHUD.fmt_credits(lim)}"
        )

    if ok:
        emit_progress(
            attempt,
            "chat_probe",
            f"[{context}] ← 200 OK in {wait_ms}ms{cred_s} · {model} — SAVE",
            email_addr,
        )
    elif status == 403 or "permission-denied" in detail.lower():
        emit_progress(
            attempt,
            "chat_probe",
            f"[{context}] ← 403 in {wait_ms}ms DENIED @{domain} no-save",
            email_addr,
        )
    else:
        emit_progress(
            attempt,
            "chat_probe",
            f"[{context}] ← {status} in {wait_ms}ms FAIL no-save",
            email_addr,
        )
    vlog(
        f"chat_probe result: ok={ok} status={status} wall_ms={wait_ms} "
        f"credits={credits} detail={detail}",
        attempt,
    )
    print(f"[{attempt}] chat_probe ({wait_ms}ms): {detail}", flush=True)
    return ok, status, detail, credits if isinstance(credits, dict) else empty_c


# ── Browser helpers ──────────────────────────────────────────────────────────
# Realistic screen caps for BrowserForge fingerprint generation (not fixed
# window size — fixed windows are a fingerprint leak per Camoufox docs).
_STEALTH_SCREENS: list[tuple[int, int]] = [
    (1920, 1080),
    (1536, 864),
    (1440, 900),
    (1366, 768),
    (2560, 1440),
    (1680, 1050),
    (1280, 800),
]
# Desktop OS mix — Windows-heavy (most common consumer desktop).
_STEALTH_OS_WEIGHTS: list[tuple[str, int]] = [
    ("windows", 70),
    ("macos", 20),
    ("linux", 10),
]


def _build_stealth_launch_kwargs(
    headless: bool,
    proxy_url: str | None,
    *,
    block_images: bool = False,
) -> dict[str, Any]:
    """Camoufox launch options: geoIP, randomized FP, anti-automation.

    - geoip=True: timezone/locale/lat-lon match exit IP (proxy or direct).
      Do NOT hardcode locale — that fights geoip and leaks "proxy IP in JP,
      browser claims en-US only" style mismatches.
    - block_webrtc: no real-IP leak via STUN.
    - disable_coop: required so Cloudflare Turnstile checkbox is clickable
      inside cross-origin iframes (Camoufox official Turnstile pattern).
    - humanize: random cursor max duration (looks less robotic than fixed 0.5).
    - os + screen: fresh BrowserForge fingerprint per browser instance.
    - Camoufox itself strips Playwright automation markers / webdriver.
    - block_images: save bandwidth (safe for tempmail OTP pages).
    """
    os_names = [n for n, _ in _STEALTH_OS_WEIGHTS]
    os_w = [w for _, w in _STEALTH_OS_WEIGHTS]
    os_pick = random.choices(os_names, weights=os_w, k=1)[0]
    max_w, max_h = random.choice(_STEALTH_SCREENS)
    # Low humanize — long mouse paths look like "animation" after Turnstile
    # and slow every click. 0.15–0.35s is enough anti-bot without lag.
    humanize = round(random.uniform(0.12, 0.35), 2)

    kwargs: dict[str, Any] = {
        "headless": headless,
        "humanize": humanize,
        "os": os_pick,
        "geoip": True,
        # Prefer English UI on accounts.x.ai — geoip alone often serves zh/ms
        # chooser labels our English heal strings never match → reload loops.
        "locale": "en-US",
        "block_webrtc": True,
        "disable_coop": True,  # Turnstile iframe clicks
        # We intentionally set disable_coop; suppress Camoufox leak spam.
        "i_know_what_im_doing": True,
        "firefox_user_prefs": {
            # Extra automation/noise hardening (Camoufox already spoofs webdriver).
            "dom.webdriver.enabled": False,
            "media.peerconnection.enabled": False,
            "privacy.trackingprotection.enabled": True,
            "network.http.sendRefererHeader": 2,
            "dom.event.clipboardevents.enabled": True,
            "intl.accept_languages": "en-US,en",
        },
    }
    if block_images:
        kwargs["block_images"] = True

    try:
        from browserforge.fingerprints import Screen  # type: ignore

        kwargs["screen"] = Screen(max_width=max_w, max_height=max_h)
    except Exception:
        # Screen constraint is optional — Camoufox still generates a random FP.
        pass

    if proxy_url:
        kwargs["proxy"] = _parse_proxy(proxy_url)

    return kwargs


# ── Etteum Browser Logs frame relay (headless screenshots → stdout JSON) ────
# When ETTEUM_FRAME_RELAY=true (set by etteum grokFarm.ts), emit periodic JPEG
# frames as single-line JSON on stdout. Multi-worker entries use workerId so
# concurrency N → N Browser Logs cards.
# Shape: ETTEUM_JSON:{"type":"frame","workerId":1,"email":"...","base64":"..."}
_FRAME_PAGES: dict[int, dict[str, Any]] = {}  # id(manager) -> {page, workerId, email}
_frame_relay_task: asyncio.Task | None = None
ETTEUM_FRAME_RELAY = _env_bool("ETTEUM_FRAME_RELAY", False)
ETTEUM_FRAME_INTERVAL = max(0.8, float(_env("ETTEUM_FRAME_INTERVAL", "1.5") or "1.5"))


def _emit_etteum_json(payload: dict[str, Any]) -> None:
    try:
        print("ETTEUM_JSON:" + json.dumps(payload, separators=(",", ":")), flush=True)
    except Exception:
        pass


async def _etteum_frame_relay_loop() -> None:
    """Screenshot every live worker page and emit one ETTEUM_JSON frame each."""
    while True:
        try:
            for mid, entry in list(_FRAME_PAGES.items()):
                try:
                    page = entry.get("page") if isinstance(entry, dict) else entry
                    if page is None:
                        continue
                    closed = getattr(page, "is_closed", None)
                    if callable(closed) and closed():
                        _FRAME_PAGES.pop(mid, None)
                        continue
                    buf = await page.screenshot(type="jpeg", quality=50)
                    worker_id = entry.get("workerId") if isinstance(entry, dict) else None
                    email = entry.get("email") if isinstance(entry, dict) else ""
                    payload: dict[str, Any] = {
                        "type": "frame",
                        "format": "jpeg",
                        "base64": base64.b64encode(buf).decode("ascii"),
                    }
                    if worker_id is not None:
                        payload["workerId"] = int(worker_id)
                    if email:
                        payload["email"] = str(email)
                    _emit_etteum_json(payload)
                except Exception:
                    continue
        except Exception:
            pass
        await asyncio.sleep(ETTEUM_FRAME_INTERVAL)


def _ensure_frame_relay() -> None:
    global _frame_relay_task
    if not ETTEUM_FRAME_RELAY:
        return
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        return
    if _frame_relay_task is None or _frame_relay_task.done():
        _frame_relay_task = loop.create_task(_etteum_frame_relay_loop())


def _register_frame_page(
    manager: Any,
    page: Any,
    *,
    preview: bool = True,
    worker_id: int | None = None,
    email: str = "",
) -> None:
    """Register page for etteum Browser Logs screenshots.

    preview=False for the temp-mail browser — only the Grok signup/OAuth
    page should stream frames. worker_id isolates concurrent farm workers.
    """
    if not ETTEUM_FRAME_RELAY or not preview or manager is None or page is None:
        return
    _FRAME_PAGES[id(manager)] = {
        "page": page,
        "workerId": worker_id,
        "email": email or "",
    }
    _ensure_frame_relay()
    if worker_id is not None:
        _emit_etteum_json(
            {
                "type": "worker_start",
                "workerId": int(worker_id),
                "email": email or f"worker #{worker_id}",
            }
        )


def _unregister_frame_page(manager: Any) -> None:
    if manager is None:
        return
    _FRAME_PAGES.pop(id(manager), None)


def _frame_set_email(manager: Any, email: str) -> None:
    """Update the email label for a registered preview page."""
    if manager is None:
        return
    entry = _FRAME_PAGES.get(id(manager))
    if isinstance(entry, dict):
        entry["email"] = email or entry.get("email") or ""


async def launch_browser(
    proxy_url: str | None,
    headless: bool | None = None,
    *,
    block_images: bool = False,
    purpose: str = "signup",
    preview: bool = True,
    worker_id: int | None = None,
    email: str = "",
):
    """Launch a stealth Camoufox browser (unique fingerprint per instance).

    headless=None (default) → use the global HEADLESS flag (existing behavior).
    Pass headless=True/False to force it — used by the temp-mail flow so the
    generator.email window can stay headless even when signup is headed.

    Launch throttle (LAUNCH_PARALLEL):
      - At most N Camoufox boots run at once (default 2) so c=5 does not open
        10 browsers + page loads on the same uplink simultaneously.
      - After boot, workers proceed fully concurrent (OTP wait, probe, …).

    Isolation (WORKER_ISOLATION=true, default):
      - Profile ownership claim is a short critical section only (so cleanup
        never deletes a sibling worker's temp profile).

    preview/worker_id/email: etteum Browser Logs frame relay (preview=False
    skips temp-mail browser streaming).
    """
    global _launch_lock
    if headless is None:
        headless = HEADLESS
    kwargs = _build_stealth_launch_kwargs(
        bool(headless), proxy_url, block_images=block_images
    )

    if _launch_lock is None:
        _launch_lock = asyncio.Lock()

    # Bound concurrent boots — main home-net / disk choke under c>=3
    async with _get_launch_sem():
        print(
            f"[launch] {purpose} waiting slot… "
            f"(max {LAUNCH_PARALLEL} simultaneous boots)",
            flush=True,
        )
        # Snapshot unowned profiles BEFORE launch (no long hold)
        before_profiles = await _run_io(_snapshot_temp_profiles)
        with _BROWSER_LOCK:
            already_owned = set(_owned_profiles)

        t0 = time.monotonic()
        manager = AsyncCamoufox(**kwargs)
        browser = await manager.__aenter__()
        # Brief settle so playwright_* dirs exist; yield so HUD can paint
        await asyncio.sleep(0.12)
        after_profiles = await _run_io(_snapshot_temp_profiles)
        candidates = (after_profiles - before_profiles) - already_owned

        # Claim exclusive ownership under lock (short)
        async with _launch_lock:
            with _BROWSER_LOCK:
                owned = candidates - set(_owned_profiles)
            _track_browser(manager, profiles=owned)

        page = await browser.new_page()
        page.set_default_timeout(60000)
        # Only Grok signup/OAuth pages stream to Browser Logs (not temp-mail).
        _register_frame_page(
            manager, page, preview=preview, worker_id=worker_id, email=email
        )
        boot_ms = int((time.monotonic() - t0) * 1000)
        try:
            _os = kwargs.get("os", "?")
            _hum = kwargs.get("humanize", "?")
            _scr = kwargs.get("screen")
            _scr_s = (
                f"{getattr(_scr, 'max_width', '?')}x{getattr(_scr, 'max_height', '?')}"
                if _scr is not None
                else "auto"
            )
            print(
                f"[stealth] {purpose} boot={boot_ms}ms os={_os} humanize={_hum}s "
                f"screen≤{_scr_s} geoip=on webrtc=block coop=off "
                f"headless={headless} block_images={block_images}",
                flush=True,
            )
        except Exception:
            pass
        return manager, browser, page


async def close_browser(manager) -> None:
    """Close THIS browser only: its driver PID tree + its claimed profiles.

    Never kills other workers' PIDs. Never deletes profiles still owned by
    another live tracked browser.
    """
    _unregister_frame_page(manager)
    entry = _untrack_browser(manager)
    # Prefer tracked identity; fall back to manager probe only for this object
    driver = None
    profiles: set[str] = set()
    if entry:
        driver = entry.get("driver_pid")
        profiles = set(entry.get("profiles") or set())
    else:
        driver = _driver_pid(manager)

    my_driver = int(driver) if driver else None
    my_profiles = {os.path.abspath(p) for p in profiles}

    def _kill_self_only() -> None:
        if my_driver:
            # Kill only this driver tree — taskkill /T is rooted at my_driver
            _kill_pid_tree(my_driver, allow_untracked=True)

    def _cleanup_self_profiles() -> None:
        if not my_profiles:
            return
        if sys.platform == "win32":
            time.sleep(0.15)
        # respect_others=True: skip if somehow another worker claimed it
        _remove_profile_dirs(
            my_profiles,
            label=f"self-pid={my_driver}",
            respect_others=True,
        )

    try:
        await manager.__aexit__(None, None, None)
    except Exception as e:
        print(
            f"[cleanup] graceful close failed ({e}); "
            f"force-killing SELF only pid={my_driver}",
            flush=True,
        )
        await _run_io(_kill_self_only)
        await _run_io(_cleanup_self_profiles)
        return

    # Graceful success path: wipe only our temps; kill only if our driver lingers
    def _after_graceful() -> None:
        _cleanup_self_profiles()
        if my_driver and _pid_alive(my_driver):
            print(
                f"[cleanup] self driver still alive → kill self tree pid={my_driver}",
                flush=True,
            )
            _kill_pid_tree(my_driver, allow_untracked=True)

    await _run_io(_after_graceful)


async def screenshot(page, attempt: int, tag: str):
    # Screenshots are OFF by default (GROK_SCREENSHOTS=true to re-enable).
    # They clutter the disk + spam the console with "screenshot: ..." lines.
    if not SCREENSHOTS_ENABLED:
        return
    try:
        path = f"{SCREENSHOT_DIR}/grok_farm_{attempt}_{tag}.png"
        await page.screenshot(path=path, full_page=True)
    except Exception:
        pass  # never let a screenshot failure break the flow OR spam the console


# ── UI language pack (detect + labels) ─────────────────────────────────────
# accounts.x.ai follows geo/IP language even when browser prefers en-US.
# We detect the live UI language from body/buttons/html lang, then prefer
# that language's labels while still falling back to every other pack.

UI_LANG_CODES = (
    "en", "zh", "zh-tw", "ms", "id", "ja", "ko", "es", "pt", "fr",
    "de", "ar", "th", "vi", "hi", "ta", "tr", "ru", "it", "nl", "pl", "uk",
)

# Per-language UI strings for critical actions (order = preference within lang)
_UI_PACK: dict[str, dict[str, list[str]]] = {
    "en": {
        "signup_with_email": [
            "Sign up with email", "Sign up with Email", "Continue with email",
            "Sign up with Email address",
        ],
        "login_with_email": [
            "Login with email", "Log in with email", "Sign in with email",
            "Sign in with Email", "Continue with email",
        ],
        "complete_signup": ["Complete sign up", "Complete Sign Up", "Create account"],
        "sign_up": ["Sign up", "Sign Up", "Create account"],
        "cookie_accept": [
            "Accept All Cookies", "Accept all cookies", "Allow All", "Accept All",
            "I Accept", "Accept",
        ],
        "cookie_reject": ["Reject All", "Reject all", "Decline All", "Deny"],
        "allow_oauth": ["Allow", "Authorize", "Accept", "Continue", "Agree"],
        "go_back": ["Go back", "Back"],
    },
    "zh": {
        "signup_with_email": [
            "使用邮箱注册", "使用电子邮件注册", "用邮箱注册", "邮箱注册",
        ],
        "login_with_email": [
            "使用邮箱登录", "使用邮箱登陆", "邮箱登录", "用邮箱登录",
        ],
        "complete_signup": ["完成注册", "完成注册信息", "完成注册表单", "创建账户"],
        "sign_up": ["注册", "立即注册", "创建账户"],
        "cookie_accept": ["接受所有 Cookie", "接受全部", "全部接受", "同意全部"],
        "cookie_reject": ["全部拒绝", "拒绝所有", "拒绝全部"],
        "allow_oauth": ["允许", "授权", "同意", "继续"],
        "go_back": ["返回", "上一步"],
    },
    "zh-tw": {
        "signup_with_email": [
            "使用電子郵件註冊", "使用電子郵件注册", "使用電郵註冊", "電郵註冊",
        ],
        "login_with_email": ["使用電子郵件登入", "使用電郵登入", "電郵登入"],
        "complete_signup": ["完成註冊", "完成注册", "建立帳戶"],
        "sign_up": ["註冊", "立即註冊"],
        "cookie_accept": ["接受所有 Cookie", "接受全部", "全部接受"],
        "cookie_reject": ["全部拒絕", "拒絕所有"],
        "allow_oauth": ["允許", "授權", "同意", "繼續"],
        "go_back": ["返回", "上一步"],
    },
    "ms": {
        "signup_with_email": [
            "Daftar dengan e-mel", "Daftar dengan emel", "Daftar dengan email",
        ],
        "login_with_email": [
            "Log masuk dengan e-mel", "Log masuk dengan emel", "Log masuk dengan email",
        ],
        "complete_signup": ["Selesaikan pendaftaran", "Lengkapkan pendaftaran"],
        "sign_up": ["Daftar", "Mendaftar"],
        "cookie_accept": [
            "Terima Semua Kuki", "Terima semua kuki", "Terima Semua", "Benarkan Semua",
        ],
        "cookie_reject": ["Tolak Semua", "Tolak semua"],
        "allow_oauth": ["Benarkan", "Izinkan", "Teruskan", "Setuju"],
        "go_back": ["Kembali"],
    },
    "id": {
        "signup_with_email": [
            "Daftar dengan email", "Daftar dengan Email", "Daftar pakai email",
        ],
        "login_with_email": [
            "Masuk dengan email", "Login dengan email", "Masuk pakai email",
        ],
        "complete_signup": ["Selesaikan pendaftaran", "Lengkapi pendaftaran"],
        "sign_up": ["Daftar", "Buat akun"],
        "cookie_accept": [
            "Terima Semua Cookie", "Terima semua cookie", "Terima Semua", "Izinkan Semua",
        ],
        "cookie_reject": ["Tolak Semua", "Tolak semua"],
        "allow_oauth": ["Izinkan", "Setuju", "Lanjutkan"],
        "go_back": ["Kembali"],
    },
    "ja": {
        "signup_with_email": ["メールで登録", "メールアドレスで登録", "メールでサインアップ"],
        "login_with_email": ["メールでログイン", "メールでサインイン"],
        "complete_signup": ["登録を完了", "サインアップを完了", "アカウントを作成"],
        "sign_up": ["登録", "サインアップ"],
        "cookie_accept": ["すべてのCookieを受け入れる", "すべて許可", "同意する"],
        "cookie_reject": ["すべて拒否", "拒否"],
        "allow_oauth": ["許可", "承認", "続行", "同意"],
        "go_back": ["戻る"],
    },
    "ko": {
        "signup_with_email": ["이메일로 가입", "이메일로 등록", "이메일로 회원가입"],
        "login_with_email": ["이메일로 로그인", "이메일로 로그인하기"],
        "complete_signup": ["가입 완료", "회원가입 완료", "계정 만들기"],
        "sign_up": ["가입", "회원가입"],
        "cookie_accept": ["모든 쿠키 수락", "모두 수락", "동의"],
        "cookie_reject": ["모두 거부", "거부"],
        "allow_oauth": ["허용", "승인", "계속", "동의"],
        "go_back": ["뒤로"],
    },
    "es": {
        "signup_with_email": [
            "Regístrate con el correo", "Registrarse con el correo",
            "Registrarse con email", "Continuar con el correo",
        ],
        "login_with_email": [
            "Iniciar sesión con el correo", "Acceder con el correo",
            "Iniciar sesión con email",
        ],
        "complete_signup": ["Completar registro", "Completar el registro", "Crear cuenta"],
        "sign_up": ["Registrarse", "Regístrate", "Crear cuenta"],
        "cookie_accept": [
            "Aceptar todas las cookies", "Aceptar todo", "Permitir todo",
        ],
        "cookie_reject": ["Rechazar todo", "Rechazar todas"],
        "allow_oauth": ["Permitir", "Autorizar", "Aceptar", "Continuar"],
        "go_back": ["Volver", "Atrás"],
    },
    "pt": {
        "signup_with_email": [
            "Cadastrar com e-mail", "Inscrever-se com e-mail", "Continuar com e-mail",
        ],
        "login_with_email": [
            "Entrar com e-mail", "Login com e-mail", "Iniciar sessão com e-mail",
        ],
        "complete_signup": ["Concluir cadastro", "Completar inscrição", "Criar conta"],
        "sign_up": ["Cadastrar", "Inscrever-se", "Criar conta"],
        "cookie_accept": [
            "Aceitar todos os cookies", "Aceitar tudo", "Permitir tudo",
        ],
        "cookie_reject": ["Rejeitar tudo", "Recusar todos"],
        "allow_oauth": ["Permitir", "Autorizar", "Aceitar", "Continuar"],
        "go_back": ["Voltar"],
    },
    "fr": {
        "signup_with_email": [
            "S'inscrire avec un e-mail", "S'inscrire par e-mail",
            "Continuer avec l'e-mail",
        ],
        "login_with_email": [
            "Se connecter avec un e-mail", "Connexion par e-mail",
        ],
        "complete_signup": [
            "Terminer l'inscription", "Compléter l'inscription", "Créer un compte",
        ],
        "sign_up": ["S'inscrire", "Créer un compte"],
        "cookie_accept": [
            "Accepter tous les cookies", "Tout accepter", "Autoriser tout",
        ],
        "cookie_reject": ["Tout refuser", "Refuser tout"],
        "allow_oauth": ["Autoriser", "Accepter", "Continuer"],
        "go_back": ["Retour"],
    },
    "de": {
        "signup_with_email": [
            "Mit E-Mail registrieren", "Mit E-Mail anmelden", "Weiter mit E-Mail",
        ],
        "login_with_email": [
            "Mit E-Mail anmelden", "Mit E-Mail einloggen", "Mit E-Mail anmelden",
        ],
        "complete_signup": [
            "Registrierung abschließen", "Anmeldung abschließen", "Konto erstellen",
        ],
        "sign_up": ["Registrieren", "Anmelden", "Konto erstellen"],
        "cookie_accept": [
            "Alle Cookies akzeptieren", "Alle akzeptieren", "Alles erlauben",
        ],
        "cookie_reject": ["Alle ablehnen", "Ablehnen"],
        "allow_oauth": ["Zulassen", "Erlauben", "Akzeptieren", "Weiter"],
        "go_back": ["Zurück"],
    },
    "ar": {
        "signup_with_email": ["التسجيل بالبريد الإلكتروني", "اشترك بالبريد"],
        "login_with_email": ["تسجيل الدخول بالبريد الإلكتروني", "الدخول بالبريد"],
        "complete_signup": ["إكمال التسجيل", "إنشاء حساب"],
        "sign_up": ["تسجيل", "إنشاء حساب"],
        "cookie_accept": ["قبول جميع ملفات تعريف الارتباط", "قبول الكل"],
        "cookie_reject": ["رفض الكل"],
        "allow_oauth": ["سماح", "تفويض", "متابعة", "موافق"],
        "go_back": ["رجوع"],
    },
    "th": {
        "signup_with_email": ["สมัครด้วยอีเมล", "ลงทะเบียนด้วยอีเมล"],
        "login_with_email": ["เข้าสู่ระบบด้วยอีเมล"],
        "complete_signup": ["ลงทะเบียนให้เสร็จ", "สร้างบัญชี"],
        "sign_up": ["สมัคร", "ลงทะเบียน"],
        "cookie_accept": ["ยอมรับคุกกี้ทั้งหมด", "ยอมรับทั้งหมด"],
        "cookie_reject": ["ปฏิเสธทั้งหมด"],
        "allow_oauth": ["อนุญาต", "ยอมรับ", "ดำเนินการต่อ"],
        "go_back": ["กลับ"],
    },
    "vi": {
        "signup_with_email": [
            "Đăng ký bằng email", "Đăng ký với email", "Tiếp tục với email",
        ],
        "login_with_email": ["Đăng nhập bằng email", "Đăng nhập với email"],
        "complete_signup": ["Hoàn tất đăng ký", "Tạo tài khoản"],
        "sign_up": ["Đăng ký", "Tạo tài khoản"],
        "cookie_accept": ["Chấp nhận tất cả cookie", "Chấp nhận tất cả"],
        "cookie_reject": ["Từ chối tất cả"],
        "allow_oauth": ["Cho phép", "Chấp nhận", "Tiếp tục"],
        "go_back": ["Quay lại"],
    },
    "hi": {
        "signup_with_email": ["ईमेल से साइन अप करें", "ईमेल से पंजीकरण"],
        "login_with_email": ["ईमेल से लॉग इन करें", "ईमेल से साइन इन"],
        "complete_signup": ["साइन अप पूरा करें", "खाता बनाएं"],
        "sign_up": ["साइन अप", "पंजीकरण"],
        "cookie_accept": ["सभी कुकीज़ स्वीकार करें", "सभी स्वीकार करें"],
        "cookie_reject": ["सभी अस्वीकार करें"],
        "allow_oauth": ["अनुमति दें", "स्वीकार करें", "जारी रखें"],
        "go_back": ["वापस"],
    },
    "ta": {
        # Seen in farm logs: குக்கீகள் அமைப்புகள் / ஏற்றுக்கொள்
        "signup_with_email": [
            "மின்னஞ்சலுடன் பதிவு செய்", "மின்னஞ்சல் மூலம் பதிவு",
        ],
        "login_with_email": ["மின்னஞ்சலுடன் உள்நுழை", "மின்னஞ்சல் மூலம் உள்நுழை"],
        "complete_signup": ["பதிவை முடிக்கவும்", "கணக்கை உருவாக்கு"],
        "sign_up": ["பதிவு செய்", "பதிவு"],
        "cookie_accept": [
            "எல்லா குக்கீகளையும் ஏற்றுக்கொள்", "அனைத்தையும் ஏற்றுக்கொள்",
        ],
        "cookie_reject": ["அனைத்தையும் நிராகரி", "நிராகரி"],
        "allow_oauth": ["அனுமதி", "ஏற்றுக்கொள்", "தொடர்"],
        "go_back": ["பின்செல்"],
    },
    "tr": {
        "signup_with_email": ["E-posta ile kaydol", "E-posta ile üye ol"],
        "login_with_email": ["E-posta ile giriş yap", "E-posta ile oturum aç"],
        "complete_signup": ["Kaydı tamamla", "Hesap oluştur"],
        "sign_up": ["Kaydol", "Üye ol"],
        "cookie_accept": ["Tüm çerezleri kabul et", "Tümünü kabul et"],
        "cookie_reject": ["Tümünü reddet"],
        "allow_oauth": ["İzin ver", "Kabul et", "Devam"],
        "go_back": ["Geri"],
    },
    "ru": {
        "signup_with_email": [
            "Зарегистрироваться по электронной почте",
            "Регистрация через email", "Продолжить с email",
        ],
        "login_with_email": [
            "Войти по электронной почте", "Войти через email",
        ],
        "complete_signup": ["Завершить регистрацию", "Создать аккаунт"],
        "sign_up": ["Зарегистрироваться", "Создать аккаунт"],
        "cookie_accept": ["Принять все файлы cookie", "Принять все"],
        "cookie_reject": ["Отклонить все"],
        "allow_oauth": ["Разрешить", "Принять", "Продолжить"],
        "go_back": ["Назад"],
    },
    "it": {
        "signup_with_email": [
            "Registrati con email", "Iscriviti con e-mail", "Continua con e-mail",
        ],
        "login_with_email": ["Accedi con email", "Accedi con e-mail"],
        "complete_signup": ["Completa la registrazione", "Crea account"],
        "sign_up": ["Registrati", "Iscriviti"],
        "cookie_accept": ["Accetta tutti i cookie", "Accetta tutto"],
        "cookie_reject": ["Rifiuta tutto"],
        "allow_oauth": ["Consenti", "Autorizza", "Continua"],
        "go_back": ["Indietro"],
    },
    "nl": {
        "signup_with_email": [
            "Aanmelden met e-mail", "Registreren met e-mail", "Doorgaan met e-mail",
        ],
        "login_with_email": ["Inloggen met e-mail", "Aanmelden met e-mail"],
        "complete_signup": ["Registratie voltooien", "Account aanmaken"],
        "sign_up": ["Aanmelden", "Registreren"],
        "cookie_accept": ["Alle cookies accepteren", "Alles accepteren"],
        "cookie_reject": ["Alles weigeren"],
        "allow_oauth": ["Toestaan", "Accepteren", "Doorgaan"],
        "go_back": ["Terug"],
    },
    "pl": {
        "signup_with_email": [
            "Zarejestruj się e-mailem", "Zarejestruj się za pomocą e-maila",
        ],
        "login_with_email": ["Zaloguj się e-mailem", "Zaloguj się za pomocą e-maila"],
        "complete_signup": ["Dokończ rejestrację", "Utwórz konto"],
        "sign_up": ["Zarejestruj się", "Utwórz konto"],
        "cookie_accept": ["Zaakceptuj wszystkie pliki cookie", "Zaakceptuj wszystko"],
        "cookie_reject": ["Odrzuć wszystko"],
        "allow_oauth": ["Zezwól", "Akceptuj", "Kontynuuj"],
        "go_back": ["Wstecz"],
    },
    "uk": {
        "signup_with_email": [
            "Зареєструватися електронною поштою", "Реєстрація через email",
        ],
        "login_with_email": ["Увійти електронною поштою", "Увійти через email"],
        "complete_signup": ["Завершити реєстрацію", "Створити обліковий запис"],
        "sign_up": ["Зареєструватися"],
        "cookie_accept": ["Прийняти всі файли cookie", "Прийняти все"],
        "cookie_reject": ["Відхилити все"],
        "allow_oauth": ["Дозволити", "Прийняти", "Продовжити"],
        "go_back": ["Назад"],
    },
}

# Strong script/word markers for language scoring (unit-tested)
_LANG_DETECT_MARKERS: dict[str, tuple[str, ...]] = {
    "zh": (r"使用邮箱", r"注册", r"登录", r"完成注册", r"接受所有", r"[\u4e00-\u9fff]{3,}"),
    "zh-tw": (r"使用電子郵", r"註冊", r"登入", r"接受所有 Cookie"),
    "ms": (r"tetapan kuki", r"terima semua", r"tolak semua", r"daftar dengan"),
    "id": (r"daftar dengan email", r"masuk dengan", r"terima semua cookie"),
    "ja": (r"メールで", r"登録", r"ログイン", r"[\u3040-\u30ff]{2,}"),
    "ko": (r"이메일로", r"가입", r"로그인", r"[\uac00-\ud7af]{2,}"),
    "es": (r"regístrate", r"registrarse", r"iniciar sesión", r"aceptar todas"),
    "pt": (r"cadastrar", r"inscrever", r"entrar com", r"aceitar todos"),
    "fr": (r"s'inscrire", r"se connecter", r"accepter tous", r"e-mail"),
    "de": (r"registrieren", r"anmelden", r"cookies akzeptieren", r"mit e-mail"),
    "ar": (r"[\u0600-\u06ff]{3,}", r"تسجيل", r"البريد"),
    "th": (r"[\u0e00-\u0e7f]{3,}", r"สมัคร", r"อีเมล"),
    "vi": (r"đăng ký", r"đăng nhập", r"chấp nhận", r"email"),
    "hi": (r"[\u0900-\u097f]{3,}", r"साइन", r"ईमेल"),
    "ta": (r"[\u0b80-\u0bff]{3,}", r"குக்கீ", r"ஏற்றுக்கொள்", r"நிராகரி"),
    "tr": (r"kaydol", r"giriş yap", r"çerez", r"e-posta"),
    "ru": (r"[\u0400-\u04ff]{3,}", r"регистрац", r"войти", r"cookie"),
    "it": (r"registrati", r"accedi", r"cookie", r"e-mail"),
    "nl": (r"aanmelden", r"inloggen", r"cookies accepteren"),
    "pl": (r"zarejestruj", r"zaloguj", r"plików cookie"),
    "uk": (r"зареєстр", r"увійти", r"файли cookie"),
    "en": (r"sign up with email", r"log in with email", r"accept all cookies", r"complete sign up"),
}


def detect_ui_language(
    *,
    body: str = "",
    html_lang: str = "",
    buttons: list[str] | None = None,
) -> str:
    """Detect accounts.x.ai / cookie UI language. Returns short code (en, zh, ms, …)."""
    html_l = (html_lang or "").strip().lower().replace("_", "-")
    if html_l:
        # lang="zh-CN" → zh, lang="zh-TW" → zh-tw
        if html_l.startswith("zh-tw") or html_l.startswith("zh-hant"):
            return "zh-tw"
        if html_l.startswith("zh"):
            return "zh"
        primary = html_l.split("-")[0]
        if primary in _UI_PACK and primary != "en":
            # Prefer non-en html lang when set (site chose it)
            return primary

    parts = [body or ""]
    if buttons:
        parts.extend(str(b) for b in buttons if b)
    sample = " ".join(parts).lower()
    if not sample.strip():
        return "en"

    scores: dict[str, float] = {code: 0.0 for code in UI_LANG_CODES}
    for code, markers in _LANG_DETECT_MARKERS.items():
        for m in markers:
            try:
                n = len(re.findall(m, sample, flags=re.I))
            except re.error:
                n = 1 if re.search(m, sample, flags=re.I) else 0
            if n:
                # Script-class markers (unicode ranges) weight less per hit
                w = 0.5 if m.startswith("[") else 2.0
                scores[code] = scores.get(code, 0.0) + n * w

    # Prefer zh-tw over zh if traditional markers stronger
    if scores.get("zh-tw", 0) >= scores.get("zh", 0) and scores.get("zh-tw", 0) > 0:
        # keep both; max will pick
        pass
    best = max(scores.items(), key=lambda kv: kv[1])
    if best[1] <= 0:
        return "en"
    return best[0]


def ui_labels(key: str, lang: str | None = None) -> list[str]:
    """Ordered labels for an action: preferred lang first, then en, then all others."""
    lang = (lang or "en").lower()
    if lang.startswith("zh-tw") or lang.startswith("zh-hant"):
        lang = "zh-tw"
    elif lang.startswith("zh"):
        lang = "zh"
    else:
        lang = lang.split("-")[0]

    out: list[str] = []
    seen: set[str] = set()

    def _add(items: list[str]) -> None:
        for s in items:
            s2 = (s or "").strip()
            if s2 and s2 not in seen:
                seen.add(s2)
                out.append(s2)

    if lang in _UI_PACK and key in _UI_PACK[lang]:
        _add(_UI_PACK[lang][key])
    if lang != "en" and key in _UI_PACK.get("en", {}):
        _add(_UI_PACK["en"][key])
    for code, pack in _UI_PACK.items():
        if code in (lang, "en"):
            continue
        if key in pack:
            _add(pack[key])
    return out


def all_ui_labels(key: str) -> list[str]:
    """Every known label for a key (en first)."""
    return ui_labels(key, "en")


# Flat list used by older call sites
_SIGNUP_WITH_EMAIL_LABELS = all_ui_labels("signup_with_email")
_LOGIN_WITH_EMAIL_LABELS = all_ui_labels("login_with_email")
_COOKIE_ACCEPT_LABELS = all_ui_labels("cookie_accept")
_COOKIE_REJECT_LABELS = all_ui_labels("cookie_reject")
_COMPLETE_SIGNUP_LABELS = all_ui_labels("complete_signup")


async def detect_page_ui_lang(page) -> str:
    """Read page sample and detect UI language (for logging + label preference)."""
    try:
        info = await page.evaluate(
            """() => {
              const body = (document.body && document.body.innerText) || '';
              const htmlLang = (document.documentElement && document.documentElement.lang) || '';
              const btns = [...document.querySelectorAll('button, a[role="button"], [role="button"]')]
                .slice(0, 30)
                .map(el => (el.innerText || el.textContent || '').trim())
                .filter(t => t && t.length < 80);
              return { body: body.slice(0, 2000), htmlLang, buttons: btns };
            }"""
        )
        if isinstance(info, dict):
            return detect_ui_language(
                body=str(info.get("body") or ""),
                html_lang=str(info.get("htmlLang") or ""),
                buttons=list(info.get("buttons") or []),
            )
    except Exception:
        pass
    return "en"


async def dismiss_cookie_banner(page) -> None:
    """OneTrust cookie modal — ACCEPT only. Never Deny / Reject / Tolak.

    User report: farm was clicking Deny. We never touch reject handlers or
    partial labels that could match the wrong button.
    """
    # 1) OneTrust accept IDs only (never #onetrust-reject-all-handler)
    for sel in (
        "#onetrust-accept-btn-handler",
        "#accept-recommended-btn-handler",
        "button#onetrust-accept-btn-handler",
        ".onetrust-accept-btn-handler",
        "button[id*='accept-btn' i]",
    ):
        try:
            btn = page.locator(sel).first
            if await btn.count() > 0 and await btn.is_visible():
                txt = ""
                try:
                    txt = (await btn.inner_text()).strip().lower()
                except Exception:
                    pass
                if any(x in txt for x in ("reject", "deny", "tolak", "decline", "refuse")):
                    continue
                await btn.click(timeout=2000)
                await asyncio.sleep(0.2)
                return
        except Exception:
            continue

    # 2) Exact Accept-All labels only (no bare "Accept" / "Allow All" partials)
    accept_exact = [
        "Accept All Cookies",
        "Accept all cookies",
        "Accept All",
        "Terima Semua Kuki",
        "Terima semua kuki",
        "Terima Semua Cookie",
        "Terima Semua",
        "接受所有 Cookie",
        "接受全部",
        "すべてのCookieを受け入れる",
        "모든 쿠키 수락",
        "Aceptar todas las cookies",
        "Aceitar todos os cookies",
        "Accepter tous les cookies",
        "Alle Cookies akzeptieren",
        "எல்லா குக்கீகளையும் ஏற்றுக்கொள்",
    ]
    for name in accept_exact:
        try:
            loc = page.get_by_role("button", name=re.compile(rf"^{re.escape(name)}$", re.I))
            if await loc.count() == 0:
                continue
            txt = (await loc.first.inner_text()).strip().lower()
            if any(x in txt for x in ("reject", "deny", "tolak", "decline", "refuse", "ablehnen")):
                continue
            await loc.first.click(timeout=2500)
            await asyncio.sleep(0.2)
            return
        except Exception:
            continue

    # 3) JS: accept id or text that is clearly Accept-All, never Reject
    try:
        await page.evaluate(
            """() => {
              const byId = document.querySelector(
                '#onetrust-accept-btn-handler, #accept-recommended-btn-handler'
              );
              if (byId) { byId.click(); return 'id'; }
              const deny = /reject|deny|decline|refuse|tolak|拒绝|拒否|거부|ablehnen|refuser|rejeitar|odmów|відхил|отклон|不同意|ไม่ยอมรับ/i;
              const acceptAll = /accept\\s*all|allow\\s*all|terima\\s*semua|aceptar\\s*tod|aceitar\\s*tod|accepter\\s*tou|alle\\s*cookies\\s*akzept|接受所有|接受全部|すべて|모든\\s*쿠키|ஏற்றுக்கொள்|قبول\\s*الكل|przyjm.*wszyst|принять\\s*все/i;
              for (const b of document.querySelectorAll('button, [role="button"]')) {
                if (b.id && /reject/i.test(b.id)) continue;
                const t = (b.innerText || b.textContent || '').trim();
                if (!t || deny.test(t)) continue;
                if (acceptAll.test(t)) { b.click(); return t.slice(0,40); }
              }
              return '';
            }"""
        )
    except Exception:
        pass


# ── DOM brain: understand page state → act (self-heal without blind waits) ───
# Stages are ordered by farm pipeline so heal knows "what to do next".
PAGE_STAGES = (
    "loading",
    "cf_challenge",
    "page_error",
    "cookie",
    "signup_chooser",
    "signup_email",
    "signup_otp",
    "signup_profile",
    "signin_chooser",
    "signin_form",
    "oauth_consent",
    "account_home",
    "grok_chat",
    "unknown",
)


async def _page_aria_snapshot(page, *, timeout_ms: int = 2500) -> str:
    """Playwright accessibility YAML (roles/names/states). Empty if unsupported."""
    try:
        fn = getattr(page, "aria_snapshot", None)
        if callable(fn):
            # Some builds accept timeout; others take no kwargs
            try:
                snap = await fn(timeout=timeout_ms)
            except TypeError:
                snap = await fn()
            return (snap or "") if isinstance(snap, str) else str(snap or "")
    except Exception:
        pass
    # Fallback: locator-rooted snapshot of main/body if page API missing
    try:
        loc = page.locator("body").first
        fn2 = getattr(loc, "aria_snapshot", None)
        if callable(fn2):
            try:
                snap = await fn2(timeout=timeout_ms)
            except TypeError:
                snap = await fn2()
            return (snap or "") if isinstance(snap, str) else str(snap or "")
    except Exception:
        pass
    return ""


def parse_aria_snapshot_signals(aria: str) -> dict[str, Any]:
    """Parse Playwright aria YAML for complete-form / stage hints (unit-tested)."""
    text = aria or ""
    low = text.lower()
    out: dict[str, Any] = {
        "hasAria": bool(text.strip()),
        "completeBtn": False,
        "completeDisabled": False,
        "hasPassword": False,
        "hasEmail": False,
        "hasOtp": False,
        "hasFirstName": False,
        "signupChooser": False,
        "signInChooser": False,
        "headingComplete": False,
    }
    if not text.strip():
        return out

    # Button lines: Complete / Create account / multi-locale
    complete_re = (
        r'complete\s+sign\s*up|create\s+account|完成注册|完成註冊|'
        r'selesaikan|lengkapkan|completar registro|concluir|登録を完了|가입'
    )
    if re.search(rf'button\s+"[^"]*(?:{complete_re})[^"]*"', low):
        out["completeBtn"] = True
        if re.search(
            rf'button\s+"[^"]*(?:{complete_re})[^"]*"[^\n]*\[disabled',
            low,
        ):
            out["completeDisabled"] = True
    if re.search(r"\b(password|textbox\s+\"password\")\b", low):
        out["hasPassword"] = True
    if re.search(r'textbox\s+"[^"]*password', low) or ("password" in low and "textbox" in low):
        out["hasPassword"] = True
    if re.search(r'textbox\s+"[^"]*email|email\b|邮箱|メール', low):
        out["hasEmail"] = True
    if re.search(r'one-time|verification code|textbox\s+"[^"]*code|验证码|確認コード', low):
        out["hasOtp"] = True
    if re.search(r'first\s*name|given.?name|名|이름', low):
        out["hasFirstName"] = True
    if re.search(r"complete your sign up|complete sign up|完成注册|完成註冊", low):
        out["headingComplete"] = True
    if re.search(
        r"sign up with email|continue with email|使用邮箱|daftar dengan|メールで登録|이메일로",
        low,
    ):
        out["signupChooser"] = True
    if re.search(
        r"(log\s*in|sign\s*in)\s+with\s+email|使用邮箱登录|masuk dengan email|メールでログイン",
        low,
    ):
        out["signInChooser"] = True
    return out


def classify_signup_api_response(
    url: str,
    status: int,
    method: str = "",
) -> str:
    """Classify network response for complete-signup truth.

    Returns: 'ok' | 'err' | 'ignore'
    Only mutating identity/signup calls count (not static accounts.x.ai assets).
    """
    u = (url or "").lower()
    m = (method or "").upper()
    code = int(status or 0)

    # Never count assets / CF / analytics
    if any(
        x in u
        for x in (
            ".js",
            ".css",
            ".png",
            ".svg",
            ".woff",
            ".ico",
            "turnstile",
            "cloudflare",
            "challenges.",
            "cdn.",
            "google-analytics",
            "googletagmanager",
            "sentry",
            "segment.",
            "hotjar",
            "favicon",
        )
    ):
        return "ignore"

    # Prefer POST/PUT/PATCH; GET page navigations are noise
    if m and m not in ("POST", "PUT", "PATCH"):
        return "ignore"
    if not m:
        # Unknown method: only allow clearly API-shaped paths
        if not any(x in u for x in ("/api/", "graphql", "oauth2/token", "/v1/", "/v2/")):
            return "ignore"

    # Relevant identity / signup surfaces
    relevant = any(
        x in u
        for x in (
            "/api/",
            "graphql",
            "signup",
            "sign-up",
            "sign_up",
            "register",
            "create-user",
            "create_user",
            "password",
            "identity",
            "auth.x.ai",
            "oauth2/token",
            "accounts.x.ai/api",
            "users",
            "credentials",
            "enrollment",
        )
    )
    if not relevant:
        return "ignore"

    if 200 <= code < 300 or code in (302, 303, 307, 308):
        return "ok"
    if code >= 400:
        return "err"
    return "ignore"


async def read_page_state(page, *, aria: bool = False) -> dict[str, Any]:
    """Single evaluate: URL, body signals, visible controls, loading flags.

    Used by smart wait/click/heal so we don't hammer dead clicks while SPA loads.
    aria=True merges accessibility snapshot (slower — use on complete/unknown only).
    """
    try:
        st = await page.evaluate(
            """() => {
              const body = (document.body && document.body.innerText) || '';
              const b = body.slice(0, 2500).toLowerCase();
              const url = location.href || '';
              const title = (document.title || '').toLowerCase();
              const htmlLang = (document.documentElement && document.documentElement.lang) || '';
              const ready = document.readyState || '';
              const spinners = document.querySelectorAll(
                '[aria-busy="true"], .loading, .spinner, [class*="spinner" i], [class*="Loading"]'
              ).length;
              const has = (re) => re.test(b) || re.test(title);
              const vis = (el) => {
                if (!el) return false;
                const r = el.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) return false;
                const s = getComputedStyle(el);
                return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
              };
              const q = (sel) => {
                try { return [...document.querySelectorAll(sel)].some(vis); } catch(e) { return false; }
              };
              const btns = [...document.querySelectorAll(
                'button, a[role="button"], [role="button"], input[type="submit"]'
              )].filter(vis).map(el => (el.innerText||el.textContent||el.value||'').trim())
                .filter(t => t && t.length < 80).slice(0, 24);
              const btnJoin = btns.join(' | ').toLowerCase();
              const hasBtn = (re) => re.test(btnJoin);
              const cf = has(/verify you are human|just a moment|hanya sebentar|checking your browser|performing security verification|security service to protect/)
                || q("iframe[src*='challenges.cloudflare'], iframe[src*='turnstile'], [data-sitekey]");
              const loadErr = has(/couldn't load|could not load|page isn't available|can't be reached|aw snap/);
              const cookie = q('#onetrust-accept-btn-handler, #onetrust-banner-sdk, [id*="onetrust"]')
                || has(/cookie|kuki|çerez|куки|ملف تعريف الارتباط|குக்கீ/)
                   && hasBtn(/accept|reject|terima|tolak|acept|aceitar|accepter|akzept|接受|拒绝|拒絕|수락|거부|อนุญาต|ปฏิเสธ|chấp nhận|ஏற்று|நிராகரி|قبول|رفض|zaakcept|прийнят|принять/i);
              const emailIn = q('input[type="email"], input[name="email"], input[autocomplete="email"]');
              const passIn = q('input[type="password"]');
              const otpIn = q('input[name="code"], input[autocomplete="one-time-code"], input[maxlength="1"]');
              const firstIn = q('input[name*="first" i], input[autocomplete="given-name"]');
              // Multi-locale provider chooser (geoip UI ≠ English)
              const chooserSignup = hasBtn(/sign up with email|continue with email/i)
                || hasBtn(/使用邮箱|使用電子郵|使用电子邮件|用邮箱/)
                || hasBtn(/daftar dengan (e-?mel|email)/i)
                || hasBtn(/s'inscrire|registrarse|cadastrar|メールで登録|이메일로|e-posta ile kaydol|зарегистрироваться|đăng ký bằng|สมัครด้วย|registrati con|aanmelden met e-mail|zarejestruj/i)
                || hasBtn(/google|apple/) && hasBtn(/sign up|daftar|注册|註冊|登録|가입|registr|cadastr|inscri|สมัคร|đăng ký|kaydol|регистр/i)
                && !emailIn;
              const chooserLogin = hasBtn(/log\\s*in with email|sign in with email|login with email/i)
                || hasBtn(/使用邮箱登录|使用邮箱登入|使用電子郵件登入/)
                || hasBtn(/masuk dengan email|log masuk dengan|entrar com|se connecter|iniciar sesión|メールでログイン|이메일로 로그인|e-posta ile giriş|войти.*email|đăng nhập bằng|เข้าสู่ระบบด้วย|accedi con|inloggen met/i);
              const complete = has(/complete your sign up|complete sign up/)
                || has(/完成注册|完成註冊|selesaikan pendaftaran|registrierung abschließen|terminer l'inscription|completar registro|concluir cadastro|登録を完了|가입 완료|hoàn tất đăng ký|kaydı tamamla|завершить регистрацию/);
              const verify = has(/verify your email|confirmation code/)
                || has(/验证.*邮件|驗證|verifikasi|sahkan|確認コード|인증 코드|código de confirmación|code de confirmation/);
              const consent = (has(/\\ballow\\b|authorize this|grant access/)
                || has(/允许|允許|benarkan|izinkan|permitir|autoriser|zulassen|許可|허용|อนุญาت|cho phép|سماح|izin ver|разрешить/))
                && (url.includes('oauth') || url.includes('consent') || url.includes('authorize'));
              const account = /accounts\\.x\\.ai\\/account\\/?$/.test(url.replace(/\\/$/,''))
                || url.includes('accounts.x.ai/account');
              const grok = url.includes('grok.com') && !cf;
              const chat = grok && (q('textarea, [contenteditable="true"]') || has(/ask grok|what do you want/));
              let stage = 'unknown';
              if (loadErr) stage = 'page_error';
              else if (cf) stage = 'cf_challenge';
              else if (cookie && !emailIn && !passIn && !otpIn) stage = 'cookie';
              else if (ready !== 'complete' && spinners > 0 && !emailIn && !passIn) stage = 'loading';
              else if (otpIn || verify) stage = 'signup_otp';
              else if (complete || (firstIn && passIn)) stage = 'signup_profile';
              else if (emailIn && !passIn && (url.includes('sign-up') || chooserSignup || has(/sign up|daftar|注册|註冊|registr/)))
                stage = 'signup_email';
              else if (chooserSignup && !emailIn) stage = 'signup_chooser';
              else if (passIn && (url.includes('sign-in') || chooserLogin || has(/log in|sign in|masuk|登录|登入|ログイン|로그인/)))
                stage = 'signin_form';
              else if (chooserLogin && !passIn) stage = 'signin_chooser';
              else if (consent) stage = 'oauth_consent';
              else if (account) stage = 'account_home';
              else if (chat) stage = 'grok_chat';
              else if (grok) stage = 'grok_chat';
              else if (ready !== 'complete' || spinners > 0) stage = 'loading';
              return {
                url, title, ready, stage, spinners, htmlLang,
                loading: ready !== 'complete' || spinners > 0,
                cf, loadErr, cookie, emailIn, passIn, otpIn, firstIn,
                chooserSignup, chooserLogin, complete, verify, consent, account, grok, chat,
                buttons: btns,
                bodySample: body.slice(0, 180).replace(/\\s+/g, ' '),
              };
            }"""
        )
        if isinstance(st, dict):
            # Detect UI language from sample (geoip pages often not English)
            try:
                st["uiLang"] = detect_ui_language(
                    body=str(st.get("bodySample") or ""),
                    html_lang=str(st.get("htmlLang") or ""),
                    buttons=list(st.get("buttons") or []),
                )
            except Exception:
                st["uiLang"] = "en"
            # Optional hybrid overlay (roles/disabled). Off by default — heal polls
            # often; full a11y snapshot each tick is too slow.
            if aria:
                try:
                    snap = await _page_aria_snapshot(page, timeout_ms=1200)
                    sig = parse_aria_snapshot_signals(snap)
                    st["aria"] = sig
                    if sig.get("hasAria"):
                        if sig.get("hasPassword"):
                            st["passIn"] = True
                        if sig.get("hasEmail"):
                            st["emailIn"] = True
                        if sig.get("hasOtp"):
                            st["otpIn"] = True
                        if sig.get("completeBtn") or sig.get("headingComplete"):
                            st["complete"] = True
                        if sig.get("completeDisabled"):
                            st["completeDisabled"] = True
                        if sig.get("signupChooser"):
                            st["chooserSignup"] = True
                        if sig.get("signInChooser"):
                            st["chooserLogin"] = True
                        stage = st.get("stage") or "unknown"
                        if stage in ("unknown", "loading"):
                            if sig.get("hasOtp"):
                                st["stage"] = "signup_otp"
                            elif sig.get("headingComplete") or (
                                sig.get("completeBtn") and sig.get("hasPassword")
                            ):
                                st["stage"] = "signup_profile"
                            elif sig.get("hasEmail") and not sig.get("hasPassword"):
                                st["stage"] = "signup_email"
                            elif sig.get("signupChooser"):
                                st["stage"] = "signup_chooser"
                            elif sig.get("signInChooser"):
                                st["stage"] = "signin_chooser"
                            elif sig.get("hasPassword") and not sig.get(
                                "headingComplete"
                            ):
                                st["stage"] = "signin_form"
                except Exception:
                    pass
            return st
    except Exception as e:
        return {
            "stage": "unknown",
            "url": "",
            "loading": True,
            "error": str(e)[:120],
            "buttons": [],
        }
    return {"stage": "unknown", "url": "", "loading": True, "buttons": []}


async def wait_dom_ready(
    page,
    attempt: int = 0,
    *,
    timeout_s: float = 12.0,
    want_not_loading: bool = True,
) -> dict[str, Any]:
    """Poll until document complete / not spinning, or stage is actionable."""
    deadline = time.monotonic() + timeout_s
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = await read_page_state(page)
        stage = last.get("stage") or "unknown"
        # Actionable stages — don't wait for "perfect" idle
        if stage in (
            "cf_challenge",
            "signup_chooser",
            "signup_email",
            "signup_otp",
            "signup_profile",
            "signin_chooser",
            "signin_form",
            "oauth_consent",
            "account_home",
            "grok_chat",
            "page_error",
            "cookie",
        ):
            return last
        if want_not_loading and not last.get("loading"):
            return last
        await asyncio.sleep(0.2)
    return last or await read_page_state(page)


async def smart_click(
    page,
    keywords: list[str],
    exclude: list[str] | None = None,
    *,
    timeout_s: float = 6.0,
    attempt: int = 0,
) -> str | None:
    """Wait until a matching button is visible+enabled, then click (force fallback)."""
    exclude = exclude or []
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        await dismiss_cookie_banner(page)
        st = await read_page_state(page)
        if st.get("stage") == "cf_challenge":
            try:
                await handle_turnstile(
                    page, attempt, max_wait=min(8.0, timeout_s),
                    require_token=False, use_global_limit=False,
                )
            except Exception:
                pass
            await asyncio.sleep(0.3)
            continue
        if st.get("stage") == "page_error":
            await recover_page_load_error(page, attempt)
            await asyncio.sleep(0.3)
            continue
        # Try role match with short wait for enabled
        for kw in keywords:
            for exact in (True, False):
                try:
                    pat = (
                        re.compile(rf"^{re.escape(kw)}$", re.I)
                        if exact
                        else re.compile(re.escape(kw), re.I)
                    )
                    loc = page.get_by_role("button", name=pat)
                    n = await loc.count()
                    if n == 0:
                        continue
                    btn = loc.first
                    if not await btn.is_visible():
                        continue
                    txt = (await btn.inner_text()).strip()
                    if exclude and any(e.lower() in txt.lower() for e in exclude):
                        continue
                    try:
                        await btn.click(timeout=2500)
                    except Exception:
                        await btn.click(timeout=2500, force=True)
                    return txt or kw
                except Exception:
                    continue
        # evaluate fallback once per loop
        hit = await click_text_button(page, keywords, exclude=exclude)
        if hit:
            return hit
        await asyncio.sleep(0.25)
    return None


async def heal_to_stage(
    page,
    attempt: int,
    desired: str | set[str],
    *,
    email_addr: str = "",
    password: str = "",
    timeout_s: float = 20.0,
) -> dict[str, Any]:
    """Observe DOM → take the right action until desired stage or timeout.

    This is the self-heal brain: no blind multi-second clicks on missing nodes.
    """
    want = {desired} if isinstance(desired, str) else set(desired)
    deadline = time.monotonic() + timeout_s
    last: dict[str, Any] = {}
    n_actions = 0
    while time.monotonic() < deadline:
        last = await wait_dom_ready(page, attempt, timeout_s=2.5)
        stage = last.get("stage") or "unknown"
        if stage in want:
            return last

        n_actions += 1
        if n_actions <= 6 or n_actions % 4 == 0:
            vlog(
                f"heal want={sorted(want)} have={stage} url={(last.get('url') or '')[:60]}",
                attempt,
            )
            emit_progress(
                attempt,
                "ui_retry",
                f"DOM {stage} → need {','.join(sorted(want))[:40]}",
                email_addr,
            )

        # --- act by current stage ---
        if stage == "cookie":
            await dismiss_cookie_banner(page)
            await asyncio.sleep(0.2)
            continue
        if stage == "cf_challenge":
            try:
                await handle_turnstile(
                    page, attempt, max_wait=12, require_token=False, use_global_limit=False,
                )
            except Exception:
                pass
            await asyncio.sleep(0.4)
            continue
        if stage == "page_error":
            await recover_page_load_error(page, attempt)
            await asyncio.sleep(0.5)
            continue
        if stage == "loading":
            await asyncio.sleep(0.35)
            continue

        # Signup path
        if "signup_email" in want or "signup_chooser" in want or "signup_otp" in want:
            if stage == "signup_chooser":
                await _click_signup_with_email(page, attempt)
                await asyncio.sleep(0.4)
                continue
            if stage == "signup_email" and "signup_otp" in want and email_addr:
                # Need submit path — fill if empty then sign up
                try:
                    await fill_input(
                        page,
                        [
                            'input[type="email"]',
                            'input[name="email"]',
                            'input[autocomplete="email"]',
                        ],
                        email_addr,
                    )
                    await smart_click(
                        page, ["Sign up"],
                        exclude=["Google", "Apple", "email", "X"],
                        timeout_s=3.0,
                        attempt=attempt,
                    )
                except Exception:
                    pass
                await asyncio.sleep(0.5)
                continue
            if stage in ("unknown", "loading") and any(
                x in want for x in ("signup_email", "signup_chooser", "signup_otp", "signup_profile")
            ):
                # Navigate toward signup if lost
                url = last.get("url") or ""
                if "sign-up" not in url:
                    await _page_soft_refresh(
                        page, attempt, reason="heal→signup", url=SIGNUP_URL,
                        step="signup_open", email_addr=email_addr,
                    )
                else:
                    await _page_soft_refresh(
                        page, attempt, reason="heal reload signup", step="signup_open",
                        email_addr=email_addr,
                    )
                continue

        # Sign-in path
        if "signin_form" in want or "signin_chooser" in want:
            if stage == "signin_chooser":
                await click_login_with_email(page)
                await asyncio.sleep(0.4)
                continue
            if stage in ("unknown", "loading") and "sign-in" not in (last.get("url") or ""):
                await _page_soft_refresh(
                    page, attempt, reason="heal→sign-in", url=SIGNIN_URL,
                    step="login", email_addr=email_addr,
                )
                continue

        # Already past desired (e.g. want email but already on OTP)
        if stage == "signup_otp" and "signup_email" in want:
            return last  # further than wanted — caller handles
        if stage == "signup_profile" and (
            "signup_email" in want or "signup_otp" in want
        ):
            return last
        if stage == "account_home":
            return last

        # Grok.com
        if "grok_chat" in want:
            if stage == "cf_challenge":
                continue
            url = last.get("url") or ""
            if "grok.com" not in url:
                await _page_soft_refresh(
                    page, attempt, reason="heal→grok.com", url="https://grok.com/",
                    step="activate", email_addr=email_addr,
                )
                continue
            if stage in ("unknown", "loading"):
                await _page_soft_refresh(
                    page, attempt, reason="heal reload grok", step="activate",
                    email_addr=email_addr,
                )
                continue

        # Soft refresh as last resort every few loops
        if n_actions % 5 == 0:
            await _page_soft_refresh(
                page, attempt, reason=f"heal stuck stage={stage}",
                step="ui_retry", email_addr=email_addr,
            )
        else:
            await asyncio.sleep(0.35)

    return last or await read_page_state(page)


async def click_text_button(page, keywords: list[str], exclude: list[str] | None = None) -> str | None:
    exclude = exclude or []
    # Prefer Playwright role/name matching (more reliable than raw DOM for React)
    for kw in keywords:
        try:
            loc = page.get_by_role("button", name=re.compile(rf"^{re.escape(kw)}$", re.I))
            if await loc.count() > 0 and await loc.first.is_visible():
                txt = (await loc.first.inner_text()).strip()
                if exclude and any(e.lower() in txt.lower() for e in exclude):
                    continue
                try:
                    await loc.first.click(timeout=3000)
                except Exception:
                    await loc.first.click(timeout=2000, force=True)
                return txt
        except Exception:
            pass
        try:
            loc = page.get_by_role("button", name=re.compile(kw, re.I))
            if await loc.count() > 0 and await loc.first.is_visible():
                txt = (await loc.first.inner_text()).strip()
                if exclude and any(e.lower() in txt.lower() for e in exclude):
                    continue
                # Avoid social providers when looking for email actions
                if exclude and any(e.lower() in txt.lower() for e in exclude):
                    continue
                try:
                    await loc.first.click(timeout=3000)
                except Exception:
                    await loc.first.click(timeout=2000, force=True)
                return txt
        except Exception:
            pass

    exclude_re = re.compile("|".join(re.escape(e) for e in exclude), re.I) if exclude else None
    return await page.evaluate(
        """({keywords, exclude}) => {
            const den = exclude ? new RegExp(exclude, 'i') : null;
            const btns = [...document.querySelectorAll('button, a, [role="button"], input[type="submit"]')];
            // Prefer exact match first
            for (const preferExact of [true, false]) {
              for (const b of btns) {
                const txt = (b.innerText || b.textContent || b.value || '').trim();
                if (!txt) continue;
                const rect = b.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) continue;
                if (den && den.test(txt)) continue;
                // Skip OneTrust / cookie UI
                if (b.id && b.id.includes('onetrust')) continue;
                if ((b.className || '').toString().includes('onetrust')) continue;
                const low = txt.toLowerCase();
                for (const kw of keywords) {
                    const k = kw.toLowerCase();
                    const hit = preferExact ? (low === k) : (low === k || low.includes(k));
                    if (hit) {
                        b.click();
                        return txt;
                    }
                }
              }
            }
            return null;
        }""",
        {"keywords": keywords, "exclude": exclude_re.pattern if exclude_re else ""},
    )


async def fill_input(page, selectors: list[str], value: str) -> bool:
    # Brief ready wait so we don't click through a loading overlay
    try:
        st = await read_page_state(page)
        if st.get("loading") or st.get("stage") in ("cf_challenge", "cookie"):
            await wait_dom_ready(page, timeout_s=3.0)
            if st.get("stage") == "cookie" or (await read_page_state(page)).get("stage") == "cookie":
                await dismiss_cookie_banner(page)
            if (await read_page_state(page)).get("stage") == "cf_challenge":
                try:
                    await handle_turnstile(
                        page, 0, max_wait=6, require_token=False, use_global_limit=False,
                    )
                except Exception:
                    pass
    except Exception:
        pass
    for sel in selectors:
        try:
            el = page.locator(sel).first
            if await el.count() == 0:
                continue
            try:
                await el.wait_for(state="visible", timeout=2500)
            except Exception:
                if not await el.is_visible():
                    continue
            try:
                await el.click(timeout=2000)
            except Exception:
                await el.click(timeout=1500, force=True)
            await el.fill("")
            await el.fill(value)
            # React-friendly events
            await el.evaluate(
                """(el, v) => {
                    const setter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    setter.call(el, v);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                }""",
                value,
            )
            return True
        except Exception:
            continue
    # JS fallback
    try:
        ok = await page.evaluate(
            """({selectors, value}) => {
                for (const sel of selectors) {
                    const el = document.querySelector(sel);
                    if (!el) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    el.focus();
                    const setter = Object.getOwnPropertyDescriptor(
                        window.HTMLInputElement.prototype, 'value'
                    ).set;
                    setter.call(el, value);
                    el.dispatchEvent(new Event('input', { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                    return true;
                }
                return false;
            }""",
            {"selectors": selectors, "value": value},
        )
        return bool(ok)
    except Exception:
        return False


async def turnstile_token_len(page) -> int:
    try:
        return int(
            await page.evaluate(
                """() => {
                    const el = document.querySelector('[name="cf-turnstile-response"], [name="cf-turnstile-response"] input, textarea[name="cf-turnstile-response"]');
                    if (el && el.value) return el.value.length;
                    const inputs = document.querySelectorAll('input[type="hidden"]');
                    for (const i of inputs) {
                        if ((i.name || '').includes('turnstile') && i.value) return i.value.length;
                    }
                    return 0;
                }"""
            )
            or 0
        )
    except Exception:
        return 0


async def read_turnstile_state(page) -> dict[str, Any]:
    """Trace Turnstile checkbox: token, mount, iframe success, fail banner.

    phase:
      solved     — hidden token present (safe to submit)
      failed     — CF "Verification failed"
      loading    — looks checked / settling, token not in DOM yet (WAIT, don't re-click)
      need_click — checkbox still needs a click
      absent     — no widget
    """
    st: dict[str, Any] = {
        "token_len": 0,
        "solved": False,
        "mounted": False,
        "iframe_n": 0,
        "label": False,
        "failed": False,
        "success_ui": False,
        "phase": "absent",
    }
    try:
        tok = await turnstile_token_len(page)
        st["token_len"] = tok
        if tok > 20:
            st["solved"] = True
            st["phase"] = "solved"
            return st
    except Exception:
        pass
    try:
        st["failed"] = await _turnstile_verification_failed(page)
        if st["failed"]:
            st["phase"] = "failed"
            return st
    except Exception:
        pass
    try:
        st["mounted"] = await _turnstile_mount_present(page)
    except Exception:
        pass
    try:
        st["label"] = await page.locator("text=Verify you are human").count() > 0
    except Exception:
        pass

    iframe_n = 0
    success_ui = False
    try:
        for f in page.frames:
            u = (f.url or "").lower()
            if "challenges.cloudflare" not in u and "turnstile" not in u:
                continue
            iframe_n += 1
            try:
                hit = await f.evaluate(
                    """() => {
                      const html = document.body ? document.body.innerHTML : '';
                      const text = document.body ? (document.body.innerText || '') : '';
                      if (/aria-checked=["']true["']/i.test(html)) return true;
                      if (/data-state=["']checked["']/i.test(html)) return true;
                      if (/\\bsuccess\\b|\\bpassed\\b|\\bverified\\b/i.test(html)) return true;
                      const cb = document.querySelector(
                        'input[type="checkbox"], [role="checkbox"]'
                      );
                      if (cb && (cb.checked || cb.getAttribute('aria-checked') === 'true'))
                        return true;
                      // Solved managed widget often has short body + svg check
                      if (document.querySelector('svg') && text.length < 30
                          && !/verify you are human/i.test(text))
                        return true;
                      return false;
                    }"""
                )
                if hit:
                    success_ui = True
            except Exception:
                pass
    except Exception:
        pass
    st["iframe_n"] = iframe_n
    st["success_ui"] = success_ui
    try:
        n = await page.locator(
            "iframe[src*='challenges.cloudflare'], iframe[src*='turnstile'], [data-sitekey]"
        ).count()
        st["iframe_n"] = max(st["iframe_n"], int(n or 0))
    except Exception:
        pass

    if st["token_len"] > 20:
        st["solved"] = True
        st["phase"] = "solved"
    elif st["failed"]:
        st["phase"] = "failed"
    elif success_ui:
        st["phase"] = "loading"  # checked look, wait for token field
    elif st["mounted"] or st["label"] or st["iframe_n"] > 0:
        st["phase"] = "need_click" if (st["label"] or st["iframe_n"] > 0) else "loading"
    else:
        st["phase"] = "absent"
    return st


async def wait_for_turnstile_solved(
    page,
    attempt: int,
    *,
    timeout_s: float = 10.0,
    after: str = "click",
) -> dict[str, Any]:
    """Wait 5–10s after click/mount; log phase so we know if checked vs stuck."""
    deadline = time.monotonic() + max(3.0, timeout_s)
    last_phase = ""
    st: dict[str, Any] = {}
    t0 = time.monotonic()
    while time.monotonic() < deadline:
        st = await read_turnstile_state(page)
        phase = str(st.get("phase") or "")
        if phase != last_phase:
            print(
                f"[{attempt}] Turnstile wait({after}): phase={phase} "
                f"token_len={st.get('token_len')} success_ui={st.get('success_ui')} "
                f"iframe={st.get('iframe_n')} left={max(0.0, deadline - time.monotonic()):.0f}s",
                flush=True,
            )
            last_phase = phase
        if st.get("solved") or int(st.get("token_len") or 0) > 20:
            st["solved"] = True
            st["phase"] = "solved"
            print(
                f"[{attempt}] Turnstile SOLVED after {after} "
                f"in {time.monotonic() - t0:.1f}s token_len={st.get('token_len')}",
                flush=True,
            )
            return st
        if st.get("failed"):
            print(f"[{attempt}] Turnstile FAILED during wait({after})", flush=True)
            return st
        await asyncio.sleep(0.5)
    st = await read_turnstile_state(page)
    print(
        f"[{attempt}] Turnstile wait({after}) done: phase={st.get('phase')} "
        f"token_len={st.get('token_len')} success_ui={st.get('success_ui')} "
        f"({time.monotonic() - t0:.1f}s)",
        flush=True,
    )
    return st


async def turnstile_visible(page) -> bool:
    try:
        st = await read_turnstile_state(page)
        if st.get("solved"):
            return False
        return st.get("phase") in ("need_click", "loading", "failed")
    except Exception:
        return False


async def try_click_turnstile(page, attempt: int) -> bool:
    """Click Cloudflare Turnstile checkbox once — no humanize mouse path.

    Prefer element/frame click over page.mouse (user: no mouse animation after check).
    """
    # Already solved — do nothing
    try:
        if await turnstile_token_len(page) > 20:
            return True
    except Exception:
        pass
    try:
        # 1) Host-page label / accessible text
        for sel in (
            'text=Verify you are human',
            'label:has-text("Verify you are human")',
            '[aria-label*="Verify you are human" i]',
        ):
            try:
                loc = page.locator(sel).first
                if await loc.count() > 0 and await loc.is_visible():
                    try:
                        await loc.click(timeout=2500, force=True)
                    except Exception:
                        await loc.click(timeout=2000, force=True)
                    vlog(f"Turnstile: clicked host text ({sel})", attempt)
                    return True
            except Exception:
                continue

        # 2) Iframe / sitekey element — direct locator click (no mouse.move trail)
        for sel in (
            'iframe[src*="challenges.cloudflare.com"]',
            'iframe[src*="turnstile"]',
            "[data-sitekey]",
            'div:has(iframe[src*="challenges.cloudflare"])',
        ):
            try:
                loc = page.locator(sel).first
                if await loc.count() == 0:
                    continue
                try:
                    await loc.click(timeout=2500, force=True, position={"x": 20, "y": 20})
                    vlog(f"Turnstile: force-click {sel}", attempt)
                    return True
                except Exception:
                    box = await loc.bounding_box(timeout=1500)
                    if not box:
                        continue
                    # Single click only — no multi-point animation
                    await page.mouse.click(
                        box["x"] + min(28, max(12, box["width"] * 0.12)),
                        box["y"] + box["height"] / 2,
                    )
                    vlog(f"Turnstile: clicked container {sel}", attempt)
                    return True
            except Exception:
                continue

        # 3) Inside CF frames — checkbox selectors
        for f in page.frames:
            if "challenges.cloudflare.com" not in (f.url or "") and "turnstile" not in (f.url or ""):
                continue
            for sel in (
                'input[type="checkbox"]',
                "label.cb-lb input",
                'label input[type="checkbox"]',
                '[role="checkbox"]',
                "body",
            ):
                try:
                    loc = f.locator(sel).first
                    if await loc.count() == 0:
                        continue
                    try:
                        await loc.click(timeout=2000)
                    except Exception:
                        box = await loc.bounding_box(timeout=1500)
                        if box:
                            await page.mouse.click(
                                box["x"] + min(20, box["width"] * 0.2),
                                box["y"] + box["height"] / 2,
                            )
                        else:
                            continue
                    vlog(f"Turnstile: clicked frame {sel}", attempt)
                    return True
                except Exception:
                    continue
    except Exception as e:
        vlog(f"Turnstile click error: {e}", attempt)
    return False


async def _turnstile_mount_present(page) -> bool:
    """True if page has a Turnstile mount/placeholder even when iframe not ready yet."""
    try:
        return bool(
            await page.evaluate(
                """() => {
                    if (document.querySelector('[data-sitekey], .cf-turnstile, #cf-turnstile, [name="cf-turnstile-response"]'))
                        return true;
                    const ifr = document.querySelectorAll('iframe');
                    for (const f of ifr) {
                        const s = (f.src || '') + (f.getAttribute('src') || '');
                        if (s.includes('challenges.cloudflare') || s.includes('turnstile')) return true;
                    }
                    // grey empty box under password on complete form is often the mount
                    const t = (document.body && document.body.innerText) || '';
                    if (/Verify you are human/i.test(t)) return true;
                    // Detect blank CF placeholder: wide short box above Complete button
                    const btns = Array.from(document.querySelectorAll('button'));
                    const complete = btns.find(b => /complete\\s+sign\\s*up/i.test((b.innerText||'').trim()));
                    if (complete) {
                        const br = complete.getBoundingClientRect();
                        const nodes = document.querySelectorAll('div, section, span');
                        for (const el of nodes) {
                            const r = el.getBoundingClientRect();
                            if (r.width < 200 || r.width > 420) continue;
                            if (r.height < 40 || r.height > 90) continue;
                            // sits just above Complete button
                            if (r.bottom <= br.top && (br.top - r.bottom) < 40 && r.bottom > br.top - 100) {
                                return true;
                            }
                        }
                    }
                    return false;
                }"""
            )
        )
    except Exception:
        return False


async def _click_turnstile_slot_above_complete(page, attempt: int) -> bool:
    """Click the blank Turnstile slot just above 'Complete sign up' (direct click)."""
    try:
        btn = page.get_by_role("button", name=re.compile(r"complete\s+sign\s*up", re.I)).first
        if await btn.count() == 0:
            return False
        box = await btn.bounding_box(timeout=2000)
        if not box:
            return False
        # Widget is a ~300x65 grey box immediately above the button
        x = box["x"] + min(28, box["width"] * 0.12)
        y = box["y"] - 36
        if y < 8:
            return False
        await page.mouse.click(x, y)
        vlog(f"Turnstile: clicked slot above Complete ({x:.0f},{y:.0f})", attempt)
        return True
    except Exception as e:
        vlog(f"Turnstile slot click warn: {e}", attempt)
        return False


async def _turnstile_verification_failed(page) -> bool:
    """True when CF shows red 'Verification failed' / Troubleshoot widget."""
    try:
        if await page.locator("text=/Verification failed/i").count() > 0:
            return True
        if await page.locator("text=/Troubleshoot/i").count() > 0:
            # Troubleshoot alone can be false positive; require nearby CF context
            body = (await page.inner_text("body"))[:2500]
            if re.search(r"Verification failed|CLOUDFLARE", body, re.I):
                return True
        return False
    except Exception:
        return False


async def _force_turnstile_remount(
    page, attempt: int, password: str | None = None, *, hard: bool = False
) -> None:
    """Recover blank / 'Verification failed' Turnstile.

    Soft (default): turnstile.reset() + password re-poke (does NOT rip iframes).
    Hard: remove dead CF iframes (last resort — can leave blank box if React won't remount).
    """
    mode = "hard" if hard else "soft"
    vlog(f"Turnstile: remount ({mode})", attempt)

    # Click CF "Troubleshoot" / retry if verification failed
    try:
        if await page.locator("text=/Verification failed/i").count() > 0:
            for sel in (
                'text=Troubleshoot',
                'a:has-text("Troubleshoot")',
                'text=/try again/i',
            ):
                try:
                    loc = page.locator(sel).first
                    if await loc.count() > 0 and await loc.is_visible():
                        await loc.click(timeout=2000)
                        await asyncio.sleep(1.5)
                        break
                except Exception:
                    continue
    except Exception:
        pass

    try:
        await page.evaluate(
            """(hard) => {
                try {
                    if (window.turnstile && typeof window.turnstile.reset === 'function') {
                        window.turnstile.reset();
                    }
                } catch (e) {}
                document.querySelectorAll(
                    '[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"], input[name*="turnstile"]'
                ).forEach(el => { try { el.value = ''; } catch (e) {} });
                if (hard) {
                    document.querySelectorAll(
                        'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"]'
                    ).forEach(f => { try { f.remove(); } catch (e) {} });
                }
            }""",
            hard,
        )
    except Exception as e:
        vlog(f"Turnstile remount JS warn: {e}", attempt)

    # Only re-type password if empty (remount must not wipe+retype every time)
    if password:
        try:
            loc = page.locator('input[type="password"]').first
            if await loc.count() > 0:
                cur = ""
                try:
                    cur = await loc.input_value()
                except Exception:
                    cur = await _password_field_value(page)
                if cur and len(cur) >= 4:
                    try:
                        await loc.evaluate("el => el.blur()")
                    except Exception:
                        pass
                else:
                    await loc.click(timeout=2000)
                    await asyncio.sleep(0.1)
                    await loc.fill(password)
                    await loc.evaluate(
                        """(el, v) => {
                            const setter = Object.getOwnPropertyDescriptor(
                                window.HTMLInputElement.prototype, 'value'
                            ).set;
                            setter.call(el, v);
                            el.dispatchEvent(new Event('input', { bubbles: true }));
                            el.dispatchEvent(new Event('change', { bubbles: true }));
                            el.dispatchEvent(new Event('blur', { bubbles: true }));
                        }""",
                        password,
                    )
        except Exception:
            pass
    # Give CF time to re-fetch challenge (concurrent IP needs breathing room)
    await asyncio.sleep(2.5 if hard else 2.0)


async def _on_complete_signup_form(page) -> bool:
    """True while 'Complete your sign up' profile step is still showing."""
    try:
        if await page.locator("text=Complete your sign up").count() > 0:
            return True
        # Fallback: Complete button + password still present
        has_btn = await page.get_by_role(
            "button", name=re.compile(r"complete\s+sign\s*up", re.I)
        ).count()
        has_pw = await page.locator('input[type="password"]').count()
        return has_btn > 0 and has_pw > 0
    except Exception:
        return False


async def _read_complete_form_state(page) -> dict[str, Any]:
    """DOM snapshot of Complete-sign-up + optional ARIA overlay (disabled/roles)."""
    try:
        st = await page.evaluate(
            """() => {
              const val = (sel) => {
                const el = document.querySelector(sel);
                return el && typeof el.value === 'string' ? el.value : '';
              };
              const vis = (sel) => {
                try {
                  const el = document.querySelector(sel);
                  if (!el) return false;
                  const r = el.getBoundingClientRect();
                  return r.width > 2 && r.height > 2;
                } catch(e) { return false; }
              };
              let tsLen = 0;
              try {
                const el = document.querySelector(
                  '[name="cf-turnstile-response"], textarea[name="cf-turnstile-response"]'
                );
                if (el && el.value) tsLen = el.value.length;
                if (!tsLen) {
                  document.querySelectorAll('input[type="hidden"]').forEach(i => {
                    if ((i.name||'').includes('turnstile') && i.value)
                      tsLen = Math.max(tsLen, i.value.length);
                  });
                }
              } catch(e) {}
              const body = (document.body?.innerText || '').slice(0, 1200).toLowerCase();
              const onComplete = body.includes('complete your sign up')
                || body.includes('complete sign up')
                || body.includes('完成注册') || body.includes('完成註冊')
                || body.includes('selesaikan pendaftaran')
                || body.includes('registrierung abschließen')
                || body.includes('completar registro')
                || body.includes('登録を完了') || body.includes('가입 완료');
              const err = body.includes('required') || body.includes('invalid')
                || body.includes('try again') || body.includes('verification failed')
                || body.includes('必填') || body.includes('无效') || body.includes('驗證失敗');
              const hasPw = !!document.querySelector('input[type="password"]');
              const hasCompleteBtn = [...document.querySelectorAll('button')].some(b => {
                const t = (b.innerText||'').trim();
                return /complete\\s*sign\\s*up|create account|完成注册|完成註冊|selesaikan|lengkapkan|abschließ|completar|concluir|登録を完了|가입 완료|hoàn tất|kaydı tamamla|завершить регистрац/i.test(t);
              });
              const first = val('input[name="firstName"]')
                || val('input[name="first_name"]')
                || val('input[autocomplete="given-name"]')
                || val('input[name="given_name"]');
              const last = val('input[name="lastName"]')
                || val('input[name="last_name"]')
                || val('input[autocomplete="family-name"]')
                || val('input[name="family_name"]');
              const pw = val('input[type="password"]') || val('input[name="password"]');
              const tsIframe = !!document.querySelector(
                'iframe[src*="challenges.cloudflare"], iframe[src*="turnstile"], [data-sitekey]'
              );
              return {
                onComplete, err, hasPw, hasCompleteBtn, first, last,
                pwLen: (pw||'').length, tsLen, tsIframe,
                url: location.href || '',
              };
            }"""
        ) or {}
        if not isinstance(st, dict):
            st = {}
        # ARIA overlay (disabled is more reliable than DOM alone)
        try:
            aria = await _page_aria_snapshot(page, timeout_ms=1500)
            sig = parse_aria_snapshot_signals(aria)
            st["aria"] = sig
            if sig.get("completeBtn"):
                st["hasCompleteBtn"] = True
            if sig.get("headingComplete"):
                st["onComplete"] = True
            if sig.get("hasPassword"):
                st["hasPw"] = True
            if sig.get("completeDisabled"):
                st["btnDisabledAria"] = True
        except Exception:
            pass
        return st
    except Exception as e:
        return {"error": str(e)[:80], "onComplete": True, "tsLen": 0, "pwLen": 0}


def classify_complete_success(
    url: str,
    stage: str,
    st: dict[str, Any] | None,
) -> bool:
    """Pure success classifier for complete-signup (unit-tested).

    Soft-reload of /sign-up can drop the complete form and land on email/chooser —
    that must NOT count as success (log: sugarloaf went login after false leave).
    """
    url_l = (url or "").lower()
    stage_s = (stage or "").strip()
    st = st or {}

    if "accounts.x.ai/account" in url_l or "grok.com" in url_l:
        return True
    # OAuth / CLI auth only — not bare substring "oauth" on unrelated paths
    if any(
        x in url_l
        for x in (
            "cli-auth",
            "/oauth/",
            "oauth2",
            "authorize?",
            "/authorize",
            "callback",
        )
    ):
        return True

    # Still clearly on complete profile step
    if st.get("onComplete") or st.get("hasCompleteBtn"):
        return False
    if st.get("hasPw") and "sign-up" in url_l:
        return False

    # Soft-refresh trap: early signup stages after reload ≠ complete success
    if stage_s in (
        "signup_email",
        "signup_chooser",
        "signup_otp",
        "signup_profile",
        "cookie",
        "loading",
        "page_error",
        "cf_challenge",
        "unknown",
        "",
    ):
        return False
    if stage_s in (
        "account_home",
        "grok_chat",
        "oauth_consent",
        "signin_form",
        "signin_chooser",
    ):
        # signin after complete often means account created (email exists)
        return True

    if not st.get("hasPw") and not st.get("onComplete") and not st.get("hasCompleteBtn"):
        if "sign-up" not in url_l:
            return True
    return False


async def _complete_form_succeeded(page) -> bool:
    """True if we left the complete-signup step (positive signals only)."""
    try:
        url = page.url or ""
        st = await _read_complete_form_state(page)
        try:
            # aria=True once here helps when DOM stage is unknown after navigate
            stage = str((await read_page_state(page, aria=True)).get("stage") or "")
        except Exception:
            stage = ""
        return classify_complete_success(url, stage, st)
    except Exception:
        return False


async def _wait_complete_button_ready(page, max_wait: float = 2.5) -> dict[str, Any]:
    """Wait briefly for Complete button to enable after CF token lands."""
    deadline = time.monotonic() + max_wait
    last: dict[str, Any] = {}
    while time.monotonic() < deadline:
        last = await _complete_button_state(page)
        if last.get("found") and not last.get("disabled") and not last.get("covered"):
            return last
        if last.get("found") and last.get("disabled"):
            # Nudge password so React re-validates
            try:
                pw = page.locator('input[type="password"]').first
                if await pw.count() > 0:
                    await pw.focus()
                    await pw.press("End")
                    await pw.evaluate("el => el.dispatchEvent(new Event('input',{bubbles:true}))")
            except Exception:
                pass
        if last.get("covered"):
            await dismiss_cookie_banner(page)
            try:
                await page.keyboard.press("Escape")
            except Exception:
                pass
        await asyncio.sleep(0.25)
    return last


async def _refill_complete_profile(
    page, first: str, last: str, password: str, attempt: int
) -> dict[str, Any]:
    """Re-fill name+password (CF often remounts and wipes fields after solve)."""
    await dismiss_cookie_banner(page)
    await fill_input(
        page,
        [
            'input[name="firstName"]',
            'input[name="first_name"]',
            'input[name="given_name"]',
            'input[name*="first" i]',
            'input[autocomplete="given-name"]',
            'input[placeholder*="First" i]',
        ],
        first,
    )
    await fill_input(
        page,
        [
            'input[name="lastName"]',
            'input[name="last_name"]',
            'input[name="family_name"]',
            'input[name*="last" i]',
            'input[autocomplete="family-name"]',
            'input[placeholder*="Last" i]',
        ],
        last,
    )
    try:
        name_inputs = await page.locator(
            'input[name="name"], input[autocomplete="name"]'
        ).all()
        if name_inputs and not await page.locator('input[name*="first" i]').count():
            await name_inputs[0].fill(f"{first} {last}")
    except Exception:
        pass
    await _ensure_password_filled(page, password, attempt)
    st = await _read_complete_form_state(page)
    vlog(
        f"complete refill first_len={len(st.get('first') or '')} "
        f"last_len={len(st.get('last') or '')} pw_len={st.get('pwLen')} "
        f"ts={st.get('tsLen')}",
        attempt,
    )
    return st


async def _complete_button_state(page) -> dict[str, Any]:
    """Inspect Complete sign-up button (DOM + ARIA disabled/covered)."""
    try:
        st = await page.evaluate(
            """() => {
              const btns = [...document.querySelectorAll('button')];
              const b = btns.find(x => /complete\\s*sign\\s*up|create account|完成注册|完成註冊|selesaikan|lengkapkan pendaftaran|registrierung|completar registro|concluir cadastro|登録を完了|가입 완료|hoàn tất|kaydı tamamla|завершить регистрац/i.test(
                (x.innerText||'').trim()));
              if (!b) return {found: false};
              const r = b.getBoundingClientRect();
              const cs = getComputedStyle(b);
              const mid = document.elementFromPoint(
                r.left + r.width/2, r.top + r.height/2);
              return {
                found: true,
                disabled: !!(b.disabled || b.getAttribute('aria-disabled') === 'true'),
                text: (b.innerText||'').trim().slice(0, 40),
                w: Math.round(r.width), h: Math.round(r.height),
                opacity: cs.opacity,
                pointerEvents: cs.pointerEvents,
                covered: !!(mid && mid !== b && !b.contains(mid)),
                coverTag: mid ? (mid.tagName + (mid.className ? '.' + String(mid.className).slice(0,40) : '')) : '',
              };
            }"""
        ) or {"found": False}
        if not isinstance(st, dict):
            st = {"found": False}
        # ARIA may surface disabled when DOM property lags React
        try:
            aria = await _page_aria_snapshot(page, timeout_ms=1000)
            sig = parse_aria_snapshot_signals(aria)
            if sig.get("completeBtn"):
                st["found"] = True
            if sig.get("completeDisabled"):
                st["disabled"] = True
                st["disabledAria"] = True
        except Exception:
            pass
        return st
    except Exception as e:
        return {"found": False, "error": str(e)[:60]}


async def _submit_complete_signup(page, attempt: int) -> bool:
    """After Turnstile token: one direct Complete click (refer-style).

    No multi-wave mouse/pointer animation — user: token ready → just click button.
    """
    await dismiss_cookie_banner(page)
    # Prefer exact Complete sign up (refer)
    try:
        btn = page.get_by_role(
            "button", name=re.compile(r"complete\s+sign\s*up", re.I)
        )
        if await btn.count() > 0 and await btn.first.is_visible():
            await btn.first.click(timeout=5000, force=True)
            vlog("complete: clicked Complete sign up", attempt)
            return True
    except Exception as e:
        vlog(f"complete role click: {e}", attempt)
    hit = await click_text_button(
        page,
        ["Complete sign up", "Complete Sign Up", "Create account"],
        exclude=["Google", "Apple", "Deny", "Cancel"],
    )
    if hit:
        vlog(f"complete: text click {hit!r}", attempt)
        return True
    try:
        ok = await page.evaluate(
            """() => {
              const b = [...document.querySelectorAll('button')].find(x =>
                /complete\\s*sign\\s*up/i.test((x.innerText||'').trim()));
              if (!b) return false;
              b.click();
              return true;
            }"""
        )
        if ok:
            vlog("complete: js click", attempt)
            return True
    except Exception:
        pass
    return False


async def handle_turnstile(
    page,
    attempt: int,
    max_wait: float = 35.0,
    *,
    require_token: bool = False,
    password: str | None = None,
    use_global_limit: bool = False,
    allow_remount: bool = True,
) -> bool:
    """Camoufox auto-pass → managed checkbox click → vision for interactive puzzles.

    require_token=True: used on Complete sign-up — blank widget means NOT ready,
    never treat absence of iframe as success.
    use_global_limit=True: acquire TURNSTILE_PARALLEL semaphore (concurrent farm).
    allow_remount=False: click-only (old complete_signup style — no soft/hard remount).
    """
    if use_global_limit:
        async with _get_turnstile_sem():
            return await _handle_turnstile_inner(
                page,
                attempt,
                max_wait,
                require_token=require_token,
                password=password,
                allow_remount=allow_remount,
            )
    return await _handle_turnstile_inner(
        page,
        attempt,
        max_wait,
        require_token=require_token,
        password=password,
        allow_remount=allow_remount,
    )


async def _handle_turnstile_inner(
    page,
    attempt: int,
    max_wait: float = 35.0,
    *,
    require_token: bool = False,
    password: str | None = None,
    allow_remount: bool = True,
) -> bool:
    """Observe → wait → click once → wait 5–10s for check (no blind r1–r5 spam)."""
    deadline = time.monotonic() + max_wait
    clicks = 0
    remounts = 0
    # First look: Camoufox often auto-passes — wait before clicking
    st0 = await wait_for_turnstile_solved(
        page, attempt, timeout_s=min(6.0, max_wait * 0.35), after="mount"
    )
    if st0.get("solved"):
        return True

    while time.monotonic() < deadline:
        st = await read_turnstile_state(page)
        phase = str(st.get("phase") or "absent")
        print(
            f"[{attempt}] Turnstile loop: phase={phase} token_len={st.get('token_len')} "
            f"success_ui={st.get('success_ui')} clicks={clicks} remounts={remounts} "
            f"left={max(0.0, deadline - time.monotonic()):.0f}s",
            flush=True,
        )

        if st.get("solved") or int(st.get("token_len") or 0) > 20:
            vlog(f"Turnstile: token present (len={st.get('token_len')})", attempt)
            return True

        # Loading / success_ui: DO NOT re-click (would reset checkbox)
        if phase == "loading" or (st.get("success_ui") and not st.get("solved")):
            stw = await wait_for_turnstile_solved(
                page, attempt,
                timeout_s=min(10.0, max(5.0, deadline - time.monotonic())),
                after="settle",
            )
            if stw.get("solved"):
                return True
            # Still no token after settle — one soft remount max
            if allow_remount and remounts < 2 and (deadline - time.monotonic()) > 8:
                await _force_turnstile_remount(
                    page, attempt, password, hard=(remounts >= 1),
                )
                remounts += 1
                clicks = 0
                continue
            if not require_token:
                return True
            continue

        if phase == "failed":
            if allow_remount and remounts < 3:
                await _force_turnstile_remount(
                    page, attempt, password, hard=(remounts >= 1),
                )
                remounts += 1
                clicks = 0
                await wait_for_turnstile_solved(
                    page, attempt, timeout_s=5.0, after="remount",
                )
                continue
            if not allow_remount:
                await try_click_turnstile(page, attempt)
                await wait_for_turnstile_solved(
                    page, attempt, timeout_s=6.0, after="fail-click",
                )
                continue
            vlog("Turnstile: Verification failed (remounts exhausted)", attempt)
            return False

        if phase == "absent":
            if not require_token:
                return True
            # Widget not mounted yet
            if clicks == 0:
                await asyncio.sleep(2.0)
            if clicks < 3:
                await _click_turnstile_slot_above_complete(page, attempt)
                await try_click_turnstile(page, attempt)
                clicks += 1
                stw = await wait_for_turnstile_solved(
                    page, attempt, timeout_s=8.0, after=f"click#{clicks}",
                )
                if stw.get("solved"):
                    return True
            elif allow_remount and remounts < 2 and (deadline - time.monotonic()) > 10:
                await _force_turnstile_remount(
                    page, attempt, password, hard=(remounts >= 1),
                )
                remounts += 1
                clicks = 0
            else:
                await asyncio.sleep(1.0)
            continue

        # need_click: click once, then wait 8–10s for check (do not spam clicks)
        if phase == "need_click" and clicks < 4:
            await try_click_turnstile(page, attempt)
            await _click_turnstile_slot_above_complete(page, attempt)
            clicks += 1
            stw = await wait_for_turnstile_solved(
                page, attempt,
                timeout_s=min(10.0, max(6.0, deadline - time.monotonic())),
                after=f"click#{clicks}",
            )
            if stw.get("solved"):
                return True
            if stw.get("phase") == "loading":
                # Checked look — keep waiting, don't remount yet
                stw2 = await wait_for_turnstile_solved(
                    page, attempt, timeout_s=8.0, after="post-check",
                )
                if stw2.get("solved"):
                    return True
            continue

        # Exhausted clicks — optional vision, then remount
        if allow_remount and remounts < 3 and (deadline - time.monotonic()) > 10:
            await _force_turnstile_remount(
                page, attempt, password, hard=(remounts >= 1),
            )
            remounts += 1
            clicks = 0
            await wait_for_turnstile_solved(
                page, attempt, timeout_s=6.0, after="remount",
            )
            continue

        if CAPTCHA_PROXY_URL or CAPTCHA_API_KEY:
            try:
                img = await page.screenshot(full_page=True)
                b64 = base64.b64encode(img).decode("ascii")
                resp = _call_vision_model(b64, _VISION_TURNSTILE_PROMPT)
                if resp and "CHECKBOX" in resp.upper():
                    await try_click_turnstile(page, attempt)
                    stw = await wait_for_turnstile_solved(
                        page, attempt, timeout_s=8.0, after="vision",
                    )
                    if stw.get("solved"):
                        return True
            except Exception as e:
                vlog(f"Turnstile vision fail: {e}", attempt)

        await asyncio.sleep(1.0)

    stf = await read_turnstile_state(page)
    if stf.get("solved") or int(stf.get("token_len") or 0) > 20:
        return True
    print(
        f"[{attempt}] Turnstile TIMEOUT after {max_wait}s: phase={stf.get('phase')} "
        f"token_len={stf.get('token_len')} success_ui={stf.get('success_ui')} "
        f"clicks={clicks} remounts={remounts}",
        flush=True,
    )
    return False


# ── OIDC helpers (CLI-style local callback server) ───────────────────────────
def generate_pkce_pair() -> tuple[str, str]:
    raw = secrets.token_bytes(96)
    verifier = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    return verifier, challenge


def extract_code_from_url(url: str) -> str | None:
    try:
        parsed = urlparse(url)
    except Exception:
        return None
    host = (parsed.hostname or "").lower()
    if host not in ("127.0.0.1", "localhost"):
        return None
    if "/callback" not in (parsed.path or "") and "code=" not in url:
        return None
    params = parse_qs(parsed.query)
    vals = params.get("code")
    return vals[0] if vals else None


def extract_oauth_callback(url: str) -> tuple[str | None, str | None]:
    """Parse (code, state) from a localhost OAuth callback URL."""
    try:
        parsed = urlparse(url)
    except Exception:
        return None, None
    host = (parsed.hostname or "").lower()
    if host not in ("127.0.0.1", "localhost"):
        return None, None
    params = parse_qs(parsed.query, keep_blank_values=True)
    code = (params.get("code") or [None])[0]
    state = (params.get("state") or [None])[0]
    if code:
        code = unquote(str(code))
    if state:
        state = unquote(str(state))
    return code, state


class CliOAuthCallbackHub:
    """Real localhost callback server — same pattern as Grok CLI / CLIProxyAPI.

    Listens on 127.0.0.1:56121 and demuxes concurrent OAuth attempts by `state`.
    This is more reliable than Playwright route.abort() for capturing ?code=.
    """

    def __init__(self) -> None:
        self._server: asyncio.AbstractServer | None = None
        self._pending: dict[str, asyncio.Future] = {}
        self._lock = asyncio.Lock()
        self._started = False

    @property
    def running(self) -> bool:
        return self._started and self._server is not None

    async def start(self) -> None:
        if self._started and self._server is not None:
            return
        try:
            self._server = await asyncio.start_server(
                self._handle_client,
                host=XAI_CALLBACK_HOST,
                port=XAI_CALLBACK_PORT,
            )
            self._started = True
            print(
                f"[oauth] CLI callback server listening on "
                f"{XAI_REDIRECT_URI}",
                flush=True,
            )
        except OSError as e:
            # Port busy (another Grok CLI / previous farm) — fall back to route capture
            self._server = None
            self._started = False
            print(
                f"[oauth] WARN cannot bind {XAI_CALLBACK_HOST}:{XAI_CALLBACK_PORT} "
                f"({e}) — will use Playwright route capture fallback",
                flush=True,
            )

    async def stop(self) -> None:
        for fut in list(self._pending.values()):
            if not fut.done():
                fut.cancel()
        self._pending.clear()
        if self._server is not None:
            self._server.close()
            try:
                await self._server.wait_closed()
            except Exception:
                pass
            self._server = None
        self._started = False

    async def register(self, state: str) -> asyncio.Future:
        """Register a waiter for this OAuth state; returns a Future[str] (code)."""
        loop = asyncio.get_running_loop()
        fut: asyncio.Future = loop.create_future()
        async with self._lock:
            old = self._pending.pop(state, None)
            if old is not None and not old.done():
                old.cancel()
            self._pending[state] = fut
        return fut

    async def unregister(self, state: str) -> None:
        async with self._lock:
            fut = self._pending.pop(state, None)
            if fut is not None and not fut.done():
                fut.cancel()

    def deliver(self, state: str | None, code: str | None) -> bool:
        """Resolve waiter for *exact* state only.

        Never deliver to a random pending waiter — concurrent workers each have
        their own PKCE verifier; giving worker B worker A's code → token
        exchange HTTP 400 (invalid_grant / code already used).
        """
        if not code or not state:
            return False
        fut = self._pending.get(state)
        if fut is None or fut.done():
            return False
        fut.set_result(code)
        return True

    async def _handle_client(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        try:
            # Read HTTP request headers
            raw = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=10.0)
        except Exception:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass
            return
        try:
            head = raw.decode("latin-1", errors="replace")
            first = head.split("\r\n", 1)[0]
            # GET /callback?code=...&state=... HTTP/1.1
            parts = first.split()
            path = parts[1] if len(parts) >= 2 else "/"
            url = f"http://{XAI_CALLBACK_HOST}:{XAI_CALLBACK_PORT}{path}"
            code, state = extract_oauth_callback(url)
            delivered = self.deliver(state, code)
            body = (
                "<!doctype html><html><body style='font-family:sans-serif;padding:2rem'>"
                "<h2>Grok OAuth OK</h2>"
                "<p>Authorization code received. You can close this tab.</p>"
                f"<p style='color:#666;font-size:12px'>state={state or '-'} "
                f"delivered={'yes' if delivered else 'no'}</p>"
                "</body></html>"
            ).encode("utf-8")
            resp = (
                b"HTTP/1.1 200 OK\r\n"
                b"Content-Type: text/html; charset=utf-8\r\n"
                b"Connection: close\r\n"
                + f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
                + body
            )
            writer.write(resp)
            await writer.drain()
            if code:
                print(
                    f"[oauth] CLI callback captured code "
                    f"(state={(state or '')[:12]}… delivered={delivered})",
                    flush=True,
                )
        except Exception as e:
            print(f"[oauth] callback handler error: {e}", flush=True)
        finally:
            try:
                writer.close()
                await writer.wait_closed()
            except Exception:
                pass


_OAUTH_HUB = CliOAuthCallbackHub()


async def ensure_cli_oauth_server() -> bool:
    """Start the CLI-style callback server if not running. Returns True if listening."""
    await _OAUTH_HUB.start()
    return _OAUTH_HUB.running


async def stop_cli_oauth_server() -> None:
    await _OAUTH_HUB.stop()


def exchange_code_for_tokens(code: str, verifier: str) -> dict:
    """POST auth.x.ai/oauth2/token. 400 usually = code already used / wrong verifier."""
    if not code or not verifier:
        raise RuntimeError("token exchange missing code or verifier")
    form = urlencode(
        {
            "grant_type": "authorization_code",
            "client_id": XAI_CLIENT_ID,
            "code": code,
            "redirect_uri": XAI_REDIRECT_URI,
            "code_verifier": verifier,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        XAI_TOKEN,
        data=form,
        headers={
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            body = ""
        # 400 invalid_grant common under concurrent OAuth (code reuse / race)
        raise RuntimeError(
            f"token exchange HTTP {e.code}: {body or e.reason} "
            f"(code_len={len(code)} verifier_len={len(verifier)})"
        ) from e
    access = data.get("access_token") or ""
    refresh = data.get("refresh_token") or ""
    if not access or not refresh:
        raise RuntimeError(f"token response missing tokens: {list(data.keys())}")
    expires_in = int(data.get("expires_in") or 21600)
    expires_at = datetime.now(timezone.utc).timestamp() + expires_in
    expires_at_iso = datetime.fromtimestamp(expires_at, timezone.utc).isoformat().replace("+00:00", "Z")
    email = ""
    id_token = data.get("id_token") or ""
    if id_token:
        try:
            payload_b64 = id_token.split(".")[1]
            payload_b64 += "=" * (-len(payload_b64) % 4)
            payload = json.loads(base64.urlsafe_b64decode(payload_b64).decode("utf-8"))
            email = payload.get("email") or ""
        except Exception:
            pass
    tokens = {
        "access_token": access,
        "refresh_token": refresh,
        "expires_at": expires_at_iso,
        "expires_in": expires_in,
        "email": email,
        "client_id": XAI_CLIENT_ID,
        "auth_mode": "oidc",
        "scope": data.get("scope") or XAI_SCOPE,
    }
    if id_token:
        tokens["id_token"] = id_token
    return tokens


# ── Signup / login UI ────────────────────────────────────────────────────────
async def _read_xai_otp_value(page) -> str:
    """Read current OTP from root input or multi-slot boxes (alnum only)."""
    try:
        raw = await page.evaluate(
            """() => {
                const norm = (s) => (s || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
                const roots = [...document.querySelectorAll(
                    'input[name="code"], input[autocomplete="one-time-code"]'
                )];
                for (const el of roots) {
                    const v = norm(el.value);
                    if (v.length >= 3) return v;
                }
                const slots = [...document.querySelectorAll('input[maxlength="1"]')];
                if (slots.length) return norm(slots.map(s => s.value || '').join(''));
                if (roots[0]) return norm(roots[0].value);
                return '';
            }"""
        )
        return (raw or "").upper()
    except Exception:
        return ""


async def _otp_form_broken(page) -> bool:
    """Zod/React broken state after bad value clear: 'expected string, received undefined'."""
    try:
        n = await page.locator("text=/expected string, received undefined/i").count()
        return n > 0
    except Exception:
        return False


async def _otp_inputs_ready(page) -> bool:
    """True when verify page has a focusable OTP control."""
    try:
        return bool(
            await page.evaluate(
                """() => {
                    const pick = document.querySelector(
                        'input[name="code"], input[autocomplete="one-time-code"], input[maxlength="1"]'
                    );
                    if (!pick) return false;
                    if (pick.disabled) return false;
                    return true;
                }"""
            )
        )
    except Exception:
        return False


async def _type_alnum(page, text: str, delay_ms: int = 40) -> None:
    """Type alnum only; prefer press_sequentially when available."""
    text = re.sub(r"[^A-Za-z0-9]", "", text or "")
    if not text:
        return
    # Playwright press_sequentially is more reliable than keyboard.type on React OTP
    try:
        focused = page.locator("input:focus").first
        if await focused.count() > 0:
            await focused.press_sequentially(text, delay=delay_ms)
            return
    except Exception:
        pass
    try:
        await page.keyboard.type(text, delay=delay_ms)
    except Exception:
        for ch in text:
            try:
                await page.keyboard.press(ch)
            except Exception:
                await page.keyboard.insert_text(ch)


async def fill_xai_otp_boxes(page, otp_chars: str, attempt: int) -> bool:
    """Fill xAI multi-segment OTP (6 alnum chars, UI shows XXX-XXX).

    Critical (from VPS screenshots):
      - NEVER set input.value = '' via JS — React/Zod ends as undefined
      - NEVER type the visual hyphen — only 6 alnum keystrokes
      - Always verify all 6 chars landed before returning True
      - Retry a few rounds — ~15% flakiness is timing/focus, not permanent fail
    """
    otp_chars = re.sub(r"[^A-Za-z0-9]", "", otp_chars or "").upper()
    if not otp_chars:
        return False
    if len(otp_chars) != 6:
        print(f"[{attempt}] WARN: OTP length {len(otp_chars)} (want 6): {otp_chars}", flush=True)

    # Hard ceiling so fill_otp never idles until account timeout
    fill_deadline = time.monotonic() + 28.0
    max_rounds = 3

    async def _verified() -> bool:
        val = await _read_xai_otp_value(page)
        ok = val == otp_chars
        if ok:
            print(f"[{attempt}] OTP verified value={val!r}", flush=True)
        return ok

    async def _soft_keyboard_clear() -> None:
        # Keyboard-only clear (safe for React). No value=''.
        for key in ("Control+a", "Meta+a"):
            try:
                await page.keyboard.press(key)
            except Exception:
                pass
        for _ in range(8):
            try:
                await page.keyboard.press("Backspace")
            except Exception:
                break

    async def _focus_otp() -> bool:
        # Prefer visible multi-slot first (what user sees), then root controller
        for sel in (
            'input[maxlength="1"]',
            'input[name="code"]',
            'input[autocomplete="one-time-code"]',
        ):
            loc = page.locator(sel).first
            try:
                if await loc.count() == 0:
                    continue
                try:
                    await loc.click(timeout=2000, force=False)
                    return True
                except Exception:
                    try:
                        await loc.click(timeout=1200, force=True)
                        return True
                    except Exception:
                        try:
                            await loc.focus(timeout=1000)
                            return True
                        except Exception:
                            continue
            except Exception:
                continue
        try:
            await page.evaluate(
                """() => {
                    const el = document.querySelector(
                        'input[maxlength="1"], input[name="code"], input[autocomplete="one-time-code"]'
                    );
                    if (el) el.focus();
                }"""
            )
            return True
        except Exception:
            return False

    async def _strategy_keyboard() -> bool:
        if not await _focus_otp():
            return False
        await asyncio.sleep(0.08)
        await _soft_keyboard_clear()
        await _type_alnum(page, otp_chars, delay_ms=35)
        await asyncio.sleep(0.2)
        val = await _read_xai_otp_value(page)
        print(f"[{attempt}] OTP keyboard value={val!r}", flush=True)
        return await _verified()

    async def _strategy_per_slot() -> bool:
        slots = page.locator('input[maxlength="1"]')
        n = await slots.count()
        if n < 1:
            return False
        # Click first, type full sequence (auto-advance)
        try:
            await slots.first.click(timeout=2000)
        except Exception:
            try:
                await slots.first.click(timeout=1000, force=True)
            except Exception:
                return False
        await asyncio.sleep(0.05)
        await _soft_keyboard_clear()
        await _type_alnum(page, otp_chars[:6], delay_ms=40)
        await asyncio.sleep(0.2)
        if await _verified():
            return True
        # Explicit per-slot: click each box, one char (no JS value setter)
        for i, ch in enumerate(otp_chars[: min(6, n)]):
            if time.monotonic() >= fill_deadline:
                break
            try:
                slot = slots.nth(i)
                await slot.click(timeout=1200)
                await page.keyboard.press("Backspace")
                await page.keyboard.type(ch, delay=30)
            except Exception:
                continue
        await asyncio.sleep(0.2)
        val = await _read_xai_otp_value(page)
        print(f"[{attempt}] OTP per-slot n={n} value={val!r}", flush=True)
        return await _verified()

    async def _strategy_paste() -> bool:
        # Paste last — some builds handle paste well; avoid native value='' clear
        if not await _focus_otp():
            return False
        try:
            ok = await page.evaluate(
                """(code) => {
                    const el = document.querySelector(
                        'input[name="code"], input[autocomplete="one-time-code"]'
                    ) || document.querySelector('input[maxlength="1"]');
                    if (!el) return false;
                    el.focus();
                    try {
                        const dt = new DataTransfer();
                        dt.setData('text/plain', code);
                        el.dispatchEvent(new ClipboardEvent('paste', {
                            bubbles: true, cancelable: true, clipboardData: dt
                        }));
                        return true;
                    } catch (e) {
                        return false;
                    }
                }""",
                otp_chars,
            )
            await asyncio.sleep(0.25)
            if ok and await _verified():
                print(f"[{attempt}] OTP filled via paste", flush=True)
                return True
        except Exception as e:
            print(f"[{attempt}] OTP paste warn: {e}", flush=True)
        return False

    # Wait briefly for controls to be ready (page can be stale after long IMAP wait)
    ready_deadline = time.monotonic() + 5.0
    while time.monotonic() < ready_deadline:
        if await _otp_inputs_ready(page):
            break
        await asyncio.sleep(0.3)
    else:
        print(f"[{attempt}] OTP inputs not ready after wait", flush=True)

    for round_i in range(1, max_rounds + 1):
        if time.monotonic() >= fill_deadline:
            break
        print(f"[{attempt}] OTP fill round {round_i}/{max_rounds}", flush=True)
        try:
            await dismiss_cookie_banner(page)
        except Exception:
            pass

        # Order: keyboard → per-slot → paste (JS setter removed — it caused Zod undefined)
        for name, strat in (
            ("keyboard", _strategy_keyboard),
            ("per_slot", _strategy_per_slot),
            ("paste", _strategy_paste),
        ):
            if time.monotonic() >= fill_deadline:
                break
            try:
                if await strat():
                    print(f"[{attempt}] OTP ok via {name} (round {round_i})", flush=True)
                    return True
            except Exception as e:
                print(f"[{attempt}] OTP {name} warn: {e}", flush=True)

        if await _otp_form_broken(page):
            print(f"[{attempt}] OTP form shows Zod broken state — retry soft", flush=True)
        await asyncio.sleep(0.35 * round_i)

    val = await _read_xai_otp_value(page)
    broken = await _otp_form_broken(page)
    print(
        f"[{attempt}] OTP fill FAILED final={val!r} want={otp_chars!r} broken={broken}",
        flush=True,
    )
    return False


# ── temp mail (generator.email via Camoufox/Playwright) ─────────────────────
# STRICT PER-WORKER isolation:
#   _tempmail_sessions[attempt_num] = own Camoufox + page + inbox URL
#   Worker A never reads/writes worker B's session.
#   Signup browser (manager) is separate — never shared with mail browser.
# Set GROK_TEMPMAIL_HEADLESS=false to watch the mail window.
_tempmail_sessions: dict[int, dict[str, Any]] = {}


def _find_otp_in_text(text: str) -> str | None:
    """Extract a verification code from arbitrary page text.

    xAI codes are 6-char alphanumeric (A-Z0-9), shown in the UI / email as the
    "XXX-XXX" form (e.g. "F2W-M9V"). do_signup() strips non-alnum chars before
    filling the 6 OTP boxes, so returning the raw "F2W-M9V" is correct.

    We try several shapes, most-specific first:
      1. "XXX-XXX"  — the real xAI subject/body form (3 alnum, hyphen, 3 alnum)
      2. "code" label line followed by the code (with or without hyphen)
      3. standalone 6-char alphanumeric token (no hyphen)
      4. inline "your code is ..." / "code: ..."
      5. fallback: first bare 6-digit number
    """
    if not text:
        return None
    up = text.upper()

    # Shape 1: the real xAI "XXX-XXX" form. Prefer the one nearest an xAI /
    # "confirmation code" mention, else the first occurrence.
    xxx_xxx = re.findall(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", up)
    if xxx_xxx:
        # If any line mentions xAI / confirmation, prefer a code on that line.
        for line in up.split("\n"):
            if ("X.AI" in line or "XAI" in line or "CONFIRMATION" in line
                    or "VERIFY" in line or "CODE" in line):
                m = re.search(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", line)
                if m:
                    return m.group(1)
        return xxx_xxx[0]

    lines = [ln.strip() for ln in text.split("\n")]

    # Shape 2: a "code" label line immediately followed by the code (hyphen ok).
    for i in range(len(lines) - 1):
        if re.match(r"^code$", lines[i], re.IGNORECASE):
            m = re.fullmatch(r"[A-Z0-9]{3}-[A-Z0-9]{3}|[A-Z0-9]{6}", lines[i + 1], re.IGNORECASE)
            if m:
                return lines[i + 1]

    # Shape 3: any standalone 6-char alphanumeric token (no hyphen).
    for ln in lines:
        if re.fullmatch(r"[A-Z0-9]{6}", ln):
            return ln

    # Shape 4: "your code is ABC123" / "code: ABC-123" style inline mentions.
    # Keyword matched case-insensitively via a char class (NOT re.IGNORECASE,
    # which would weaken the gap). Lazy gap so we grab the nearest code after
    # the word "code". Tolerates the hyphenated form.
    m = re.search(r"\b[Cc][Oo][Dd][Ee]\b.{0,25}?([A-Za-z0-9]{3}-[A-Za-z0-9]{3}|[A-Za-z0-9]{6})\b", text)
    if m:
        return m.group(1)

    # Shape 5: last resort — first bare 6-digit number in the text.
    m = re.search(r"\b(\d{6})\b", text)
    if m:
        return m.group(1)
    return None


def _tempmail_inbox_urls(email_addr: str) -> list[str]:
    """generator.email accepts several inbox URL shapes — try all (per-worker)."""
    email_addr = (email_addr or "").strip()
    if "@" not in email_addr:
        return []
    user, domain = email_addr.rsplit("@", 1)
    user, domain = user.strip(), domain.strip()
    # Order: most reliable first (refer uses domain/user; farm also saw full-email form)
    return [
        f"https://generator.email/{domain}/{user}",
        f"https://generator.email/{email_addr}",
        f"https://generator.email/{email_addr.replace('@', '%40')}",
    ]


async def _tempmail_read_address(mail_page) -> str:
    """DOM-aware read of the pinned generator.email address."""
    try:
        email = await mail_page.evaluate(
            """() => {
              const sels = [
                '#email_ch_text', '#email_id', '#email',
                '[id*="email" i]', '.email', 'input[readonly]'
              ];
              for (const s of sels) {
                const el = document.querySelector(s);
                if (!el) continue;
                const t = (el.textContent || el.value || '').trim();
                if (t && t.includes('@') && !t.includes('undefined')) return t;
              }
              // fallback: any @ in body that looks like an email
              const m = (document.body?.innerText || '').match(
                /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}/
              );
              return m ? m[0] : '';
            }"""
        )
        return (email or "").strip()
    except Exception:
        return ""


async def tempmail_gen_email(mail_page, attempt: int, max_rolls: int = 25) -> str:
    """Open generator.email and return a non-blacklisted address (this worker only).

    Self-heal: soft-reload home if address never appears; re-roll via
    /email-generator when domain is blacklisted.
    """
    emit_progress(attempt, "tempmail_open", f"[w{attempt}] open generator.email", "")
    try:
        await mail_page.goto(
            "https://generator.email/", wait_until="domcontentloaded", timeout=45000
        )
    except Exception as e:
        print(f"[{attempt}] tempmail home goto fail: {e} — retry", flush=True)
        await asyncio.sleep(1.0)
        await mail_page.goto(
            "https://generator.email/", wait_until="commit", timeout=45000
        )

    rolls = 0
    email = ""
    while rolls < max_rolls:
        rolls += 1
        email = ""
        deadline = time.monotonic() + 18.0
        soft_reloads = 0
        while time.monotonic() < deadline:
            # CF / blank page on generator.email
            try:
                body = ((await mail_page.inner_text("body")) or "")[:400].lower()
            except Exception:
                body = ""
            if any(
                x in body
                for x in (
                    "just a moment",
                    "verify you are human",
                    "checking your browser",
                    "hanya sebentar",
                )
            ):
                try:
                    await handle_turnstile(
                        mail_page, attempt, max_wait=10,
                        require_token=False, use_global_limit=False,
                    )
                except Exception:
                    pass
                await asyncio.sleep(0.5)
                continue

            email = await _tempmail_read_address(mail_page)
            if email and "@" in email and "undefined" not in email.lower():
                break

            # Soft-reload this worker's mail page only (no shared state)
            if soft_reloads < 2 and time.monotonic() > deadline - 10:
                soft_reloads += 1
                emit_progress(
                    attempt, "tempmail_open",
                    f"[w{attempt}] no address — reload mail page",
                    "",
                )
                try:
                    await mail_page.reload(wait_until="domcontentloaded", timeout=20000)
                except Exception:
                    try:
                        await mail_page.goto(
                            "https://generator.email/",
                            wait_until="domcontentloaded",
                            timeout=30000,
                        )
                    except Exception:
                        pass
                await asyncio.sleep(0.8)
                continue
            await asyncio.sleep(0.35)

        if not email or "@" not in email:
            await screenshot(mail_page, attempt, "tempmail_no_address")
            raise RecoverableFarmError(
                "tempmail: generator.email never returned an address (worker mail browser)",
                delay_s=1.5,
                tag="TempmailNoAddr",
            )

        domain = email.rsplit("@", 1)[-1].strip().lower()
        if not blacklist_contains(domain):
            print(f"[{attempt}] tempmail address: {email}", flush=True)
            if rolls > 1:
                print(
                    f"[{attempt}] tempmail rolled {rolls}x to avoid blacklist",
                    flush=True,
                )
            # Cache inbox URLs on this worker's session for OTP poll
            sess = _tempmail_sessions.get(attempt)
            if isinstance(sess, dict):
                sess["email"] = email
                sess["inbox_urls"] = _tempmail_inbox_urls(email)
            return email

        print(
            f"[{attempt}] tempmail domain {domain!r} blacklisted, re-rolling...",
            flush=True,
        )
        emit_progress(
            attempt, "tempmail_open",
            f"[w{attempt}] roll domain @{domain}",
            email,
        )
        try:
            await mail_page.goto(
                "https://generator.email/email-generator",
                wait_until="domcontentloaded",
                timeout=45000,
            )
        except Exception:
            await mail_page.goto(
                "https://generator.email/",
                wait_until="domcontentloaded",
                timeout=45000,
            )
        await asyncio.sleep(0.45)

    await screenshot(mail_page, attempt, "tempmail_all_blacklisted")
    raise RecoverableFarmError(
        f"tempmail: {rolls} rolls all blacklisted (last={email!r})",
        delay_s=2.0,
        tag="TempmailAllBlacklisted",
    )


async def tempmail_read_otp(
    mail_page, email_addr: str, timeout_s: int, attempt: int
) -> str | None:
    """Poll THIS worker's generator.email inbox for xAI OTP (isolated).

    Self-heal techniques (no waiting on other workers):
      - dual inbox URL shapes (domain/user + full email)
      - DOM change detection (skip re-parse of same body)
      - click xAI / verify / confirmation rows with multiple selectors
      - soft-reload inbox every few seconds if empty
      - alternate inbox URL if one shape 404s
      - per-worker HUD status with elapsed / remaining
    """
    if "@" not in (email_addr or ""):
        return None

    sess = _tempmail_sessions.get(attempt)
    # Isolation guard: never use another worker's page
    if isinstance(sess, dict) and sess.get("page") is not None:
        if sess.get("page") is not mail_page:
            print(
                f"[{attempt}] WARN: tempmail page mismatch — using caller's page only",
                flush=True,
            )
        urls = list(sess.get("inbox_urls") or []) or _tempmail_inbox_urls(email_addr)
    else:
        urls = _tempmail_inbox_urls(email_addr)
    if not urls:
        return None

    url_i = 0
    inbox_url = urls[url_i]
    emit_progress(
        attempt, "tempmail_otp",
        f"[w{attempt}] poll inbox ≤{timeout_s}s",
        email_addr,
    )
    start = time.time()
    deadline = start + timeout_s
    last_nav = 0.0
    last_body = ""
    empty_streak = 0
    heal_cycles = 0

    async def _goto_inbox(url: str) -> bool:
        try:
            await mail_page.goto(url, wait_until="domcontentloaded", timeout=30000)
            return True
        except Exception as e:
            print(f"[{attempt}] tempmail inbox goto warn: {e}", flush=True)
            try:
                await mail_page.goto(url, wait_until="commit", timeout=20000)
                return True
            except Exception:
                return False

    if not await _goto_inbox(inbox_url):
        # try alternate URL immediately
        if len(urls) > 1:
            url_i = 1
            inbox_url = urls[url_i]
            await _goto_inbox(inbox_url)
    last_nav = time.time()

    while time.time() < deadline:
        elapsed = int(time.time() - start)
        left = max(0, int(deadline - time.time()))
        # Per-worker status only (HUD keys by attempt)
        if elapsed % 4 == 0:
            emit_progress(
                attempt,
                "tempmail_otp",
                f"[w{attempt}] inbox {elapsed}s · left {left}s · heal={heal_cycles}",
                email_addr,
            )

        # CF on mail site (this worker's page only)
        try:
            b0 = ((await mail_page.inner_text("body")) or "")[:300].lower()
        except Exception:
            b0 = ""
        if any(
            x in b0
            for x in ("just a moment", "verify you are human", "checking your browser")
        ):
            try:
                await handle_turnstile(
                    mail_page, attempt, max_wait=10,
                    require_token=False, use_global_limit=False,
                )
            except Exception:
                pass
            await asyncio.sleep(0.4)

        # Re-navigate at most every 4s to force inbox refresh
        if time.time() - last_nav > 4.0:
            await _goto_inbox(inbox_url)
            last_nav = time.time()
            await asyncio.sleep(0.35)

        # Click likely xAI verification rows (broad selectors)
        try:
            clicked = await mail_page.evaluate(
                """() => {
                  const sels = [
                    'tr', '.e7m.row', '.e7m', '.email-item', 'li.mail',
                    '[class*="mail"]', '[class*="message"]', 'a[href*="message"]',
                    '.list-group-item', 'div[onclick]'
                  ];
                  const nodes = [];
                  for (const s of sels) {
                    try { nodes.push(...document.querySelectorAll(s)); } catch(e) {}
                  }
                  const keys = ['x.ai','xai','verify','verification','confirm',
                                'code','otp','security'];
                  for (const el of nodes) {
                    const t = (el.textContent || '').trim().toLowerCase();
                    if (!t || t.length < 4 || t.length > 500) continue;
                    if (keys.some(k => t.includes(k))) {
                      try { el.click(); return true; } catch(e) {}
                    }
                  }
                  // fallback: click first non-empty row
                  for (const el of nodes) {
                    const t = (el.textContent || '').trim();
                    if (t.length > 8 && t.length < 300) {
                      try { el.click(); return 'first'; } catch(e) {}
                    }
                  }
                  return false;
                }"""
            )
        except Exception:
            clicked = False

        await asyncio.sleep(0.45 if clicked else 0.3)

        # Read body — only parse when DOM text changed (faster + accurate)
        try:
            body_text = await mail_page.evaluate(
                """() => {
                  const main = document.querySelector(
                    '#email_body, .email_body, .message, .mail-body, #message, iframe'
                  );
                  // prefer message pane if present
                  const panes = document.querySelectorAll(
                    '#email_body, .email_body, .message-body, .mail_message, #message'
                  );
                  let t = '';
                  for (const p of panes) {
                    const x = (p.innerText || p.textContent || '').trim();
                    if (x.length > t.length) t = x;
                  }
                  if (!t) t = document.body?.innerText || '';
                  return t;
                }"""
            ) or ""
        except Exception:
            body_text = ""

        if body_text and body_text != last_body:
            last_body = body_text
            code = _find_otp_in_text(body_text)
            if code:
                print(f"[{attempt}] tempmail OTP found: {code}", flush=True)
                emit_progress(
                    attempt, "tempmail_otp",
                    f"[w{attempt}] OTP {code}",
                    email_addr,
                )
                return code
            empty_streak = 0
        else:
            empty_streak += 1

        # Self-heal empty inbox (this worker only)
        if empty_streak >= 4:
            empty_streak = 0
            heal_cycles += 1
            # Rotate inbox URL shape
            if len(urls) > 1:
                url_i = (url_i + 1) % len(urls)
                inbox_url = urls[url_i]
            emit_progress(
                attempt, "tempmail_otp",
                f"[w{attempt}] empty inbox — heal #{heal_cycles} url#{url_i + 1}",
                email_addr,
            )
            print(
                f"[{attempt}] tempmail heal: empty → reload {inbox_url[:60]}",
                flush=True,
            )
            try:
                await mail_page.reload(wait_until="domcontentloaded", timeout=20000)
            except Exception:
                await _goto_inbox(inbox_url)
            last_nav = time.time()
            last_body = ""
            # Every 3rd heal: re-open generator home then inbox (session glitch)
            if heal_cycles % 3 == 0:
                try:
                    await mail_page.goto(
                        "https://generator.email/",
                        wait_until="domcontentloaded",
                        timeout=25000,
                    )
                    await asyncio.sleep(0.5)
                except Exception:
                    pass
                await _goto_inbox(inbox_url)
                last_nav = time.time()

        await asyncio.sleep(0.4)

    print(f"[{attempt}] tempmail OTP timed out after {timeout_s}s", flush=True)
    emit_progress(
        attempt, "tempmail_otp",
        f"[w{attempt}] OTP timeout {timeout_s}s",
        email_addr,
    )
    try:
        await screenshot(mail_page, attempt, "tempmail_otp_timeout")
    except Exception:
        pass
    return None


async def tempmail_close(attempt: int) -> None:
    """Close ONLY this worker's temp-mail browser (never touches siblings)."""
    sess = _tempmail_sessions.pop(attempt, None)
    if sess is None:
        return
    # Support legacy tuple form and new dict form
    if isinstance(sess, dict):
        page = sess.get("page")
        browser = sess.get("browser")
        manager = sess.get("manager")
    else:
        page, browser, manager = sess[0], sess[1], sess[2]
    try:
        if page is not None:
            await page.close()
    except Exception:
        pass
    try:
        if browser is not None:
            await browser.close()
    except Exception:
        pass
    if manager is not None:
        await close_browser(manager)


async def wait_otp_imap_keepalive(
    page, email_addr: str, timeout_s: int, since_ts: float, attempt: int
) -> str | None:
    """Poll IMAP in a thread while gently keeping the browser page awake.

    Long idle during OTP wait can leave Camoufox/React inputs sticky (~flaky fill).
    """
    loop = asyncio.get_event_loop()
    fut = loop.run_in_executor(
        None,
        lambda: read_otp_from_imap_sync(email_addr, timeout_s, since_ts),
    )
    tick = 0
    while not fut.done():
        tick += 1
        try:
            # Light keep-alive: title read + cookie dismiss; no navigation
            await page.evaluate("() => document.title")
            if tick % 3 == 0:
                try:
                    await dismiss_cookie_banner(page)
                except Exception:
                    pass
            # Confirm OTP field still present
            if tick % 4 == 0 and not await _otp_inputs_ready(page):
                print(f"[{attempt}] WARN: OTP inputs missing during IMAP wait", flush=True)
        except Exception as e:
            print(f"[{attempt}] page keep-alive warn: {e}", flush=True)
        try:
            await asyncio.wait({fut}, timeout=3.5)
        except Exception:
            await asyncio.sleep(3.5)
    return fut.result()


async def wait_for_selector_any(page, selectors: list[str], timeout_ms: int = 15000) -> str | None:
    """Poll selectors; also reacts to CF/cookie so we don't spin on a blocked DOM."""
    deadline = time.monotonic() + timeout_ms / 1000.0
    while time.monotonic() < deadline:
        try:
            st = await read_page_state(page)
            if st.get("stage") == "cookie":
                await dismiss_cookie_banner(page)
            elif st.get("stage") == "cf_challenge":
                try:
                    await handle_turnstile(
                        page, 0, max_wait=6, require_token=False, use_global_limit=False,
                    )
                except Exception:
                    pass
            elif st.get("stage") == "page_error":
                await recover_page_load_error(page, 0)
        except Exception:
            pass
        for sel in selectors:
            try:
                loc = page.locator(sel).first
                if await loc.count() > 0 and await loc.is_visible():
                    return sel
            except Exception:
                continue
        await asyncio.sleep(0.2)
    return None


async def _click_signup_with_email(page, attempt: int) -> bool:
    """Click provider chooser → email path (detect UI lang, prefer its labels)."""
    st = await heal_to_stage(
        page, attempt, {"signup_chooser", "signup_email", "signup_otp", "signup_profile"},
        timeout_s=8.0,
    )
    if st.get("stage") in ("signup_email", "signup_otp", "signup_profile"):
        return True  # already past chooser
    lang = str(st.get("uiLang") or "") or await detect_page_ui_lang(page)
    labels = ui_labels("signup_with_email", lang)
    print(f"[{attempt}] uiLang={lang} signup-email labels={len(labels)}", flush=True)
    clicked = await smart_click(
        page,
        labels,
        exclude=[
            "Google", "Apple", "Microsoft", " with X", " X ",
            "使用 X", "使用 Google", "使用 Apple", "con Google", "avec Google",
            "mit Google", "dengan Google", "с Google",
        ],
        timeout_s=5.0,
        attempt=attempt,
    )
    if clicked:
        print(f"[{attempt}] Clicked signup-email ({lang}): {clicked}", flush=True)
        return True
    # Semantic JS fallback — email path in any language
    try:
        hit = await page.evaluate(
            """() => {
              const reMail = /email|e-?mail|邮箱|郵件|電郵|メール|이메일|correo|e-?mel|почт|อีเมล|மின்|بريد|e-posta/i;
              const reSign = /sign\\s*up|daftar|注册|註冊|登録|가입|regist|cadastr|inscri|สมัคร|đăng\\s*ký|kaydol|регистр|zarejestr|aanmelden|iscriv/i;
              const skip = /google|apple|microsoft|\\bx\\b|推特|twitter/i;
              const btns = [...document.querySelectorAll('button, a[role="button"], [role="button"]')];
              for (const b of btns) {
                const t = (b.innerText || b.textContent || '').trim();
                if (!t || t.length > 80) continue;
                if (skip.test(t) && !reMail.test(t)) continue;
                if (reMail.test(t) && reSign.test(t)) { b.click(); return t.slice(0, 48); }
              }
              for (const b of btns) {
                const t = (b.innerText || '').trim();
                if (/使用邮箱|使用郵件|使用电子邮|使用電郵/.test(t)) {
                  b.click(); return t.slice(0, 48);
                }
              }
              return '';
            }"""
        )
        if hit:
            print(f"[{attempt}] Clicked signup-email (js/{lang}): {hit}", flush=True)
            return True
    except Exception as e:
        vlog(f"signup email js click warn: {e}", attempt)
    return False


_SIGNUP_EMAIL_SELS = [
    'input[name="email"]',
    'input[type="email"]',
    'input[autocomplete="email"]',
    'input[placeholder*="email" i]',
    'input[id*="email" i]',
]


async def _page_soft_refresh(
    page,
    attempt: int,
    *,
    reason: str,
    url: str | None = None,
    step: str = "retry",
    email_addr: str = "",
) -> None:
    """Same-browser recovery: reload current page or re-goto a URL.

    Prefer this over RecoverableFarmError (full browser re-spawn) for UI glitches.
    """
    emit_progress(attempt, step, f"soft-refresh · {reason}", email_addr)
    print(f"[{attempt}] soft-refresh: {reason}" + (f" → {url}" if url else " (reload)"), flush=True)
    try:
        if url:
            try:
                await page.goto(url, wait_until="domcontentloaded", timeout=45000)
            except Exception:
                await page.goto(url, wait_until="commit", timeout=45000)
        else:
            try:
                await page.reload(wait_until="domcontentloaded", timeout=30000)
            except Exception:
                # Fallback: re-goto current URL
                cur = ""
                try:
                    cur = page.url or ""
                except Exception:
                    pass
                if cur and cur.startswith("http"):
                    await page.goto(cur, wait_until="domcontentloaded", timeout=45000)
    except Exception as e:
        print(f"[{attempt}] soft-refresh warn: {e}", flush=True)
    await asyncio.sleep(1.0)
    await recover_page_load_error(page, attempt)
    await dismiss_cookie_banner(page)


async def _goto_signup_page(page, attempt: int) -> None:
    """Navigate (or hard-refresh) to accounts.x.ai/sign-up."""
    await _page_soft_refresh(
        page, attempt, reason="open sign-up", url=SIGNUP_URL, step="signup_open",
    )


async def _wait_signup_email_input(page, attempt: int, timeout_s: float = 12.0) -> str | None:
    """Wait for email field on the *current* page (no full restart).

    Handles CF, cookie banner, and re-clicking "Sign up with email".
    Does NOT reload the page — caller does refresh loops.
    """
    deadline = time.monotonic() + timeout_s
    reclicked = False
    while time.monotonic() < deadline:
        await recover_page_load_error(page, attempt)
        await dismiss_cookie_banner(page)
        try:
            body = ((await page.inner_text("body")) or "")[:800].lower()
        except Exception:
            body = ""
        if any(
            n in body
            for n in (
                "verify you are human",
                "just a moment",
                "hanya sebentar",
                "checking your browser",
            )
        ):
            try:
                await handle_turnstile(
                    page, attempt, max_wait=10, require_token=False, use_global_limit=False,
                )
            except Exception:
                pass
            await asyncio.sleep(0.5)
            continue

        sel = await wait_for_selector_any(page, _SIGNUP_EMAIL_SELS, 2000)
        if sel:
            return sel

        # Provider chooser still showing — click email path (multi-locale)
        chooser = False
        try:
            chooser = (
                await page.locator(
                    "text=/Sign up with email|Continue with Google|Sign up with Google|"
                    "使用邮箱注册|使用電子郵件|使用 X 注册|使用 Google|Daftar dengan/i"
                ).count()
                > 0
            )
        except Exception:
            pass
        if not chooser:
            try:
                stc = await read_page_state(page)
                chooser = bool(stc.get("chooserSignup") or stc.get("stage") == "signup_chooser")
            except Exception:
                pass
        if chooser:
            if not reclicked:
                print(f"[{attempt}] signup: click Sign up with email (i18n)", flush=True)
            await _click_signup_with_email(page, attempt)
            reclicked = True
            await asyncio.sleep(0.7)
            continue

        await asyncio.sleep(0.35)
    return None


async def _ensure_signup_email_ready(
    page, attempt: int, email_addr: str, *, page_refreshes: int = 3,
) -> str:
    """Find email input using DOM brain; soft-refresh only when stage is wrong.

    page_refreshes: max full page reloads before escalating to browser re-spawn.
    """
    for refresh_i in range(page_refreshes + 1):
        if refresh_i == 0:
            emit_progress(attempt, "signup_open", "Opening sign-up page", email_addr)
            await _goto_signup_page(page, attempt)
        else:
            emit_progress(
                attempt,
                "signup_open",
                f"DOM heal refresh {refresh_i}/{page_refreshes}",
                email_addr,
            )
            print(
                f"[{attempt}] signup: DOM still not signup_email → soft-refresh "
                f"({refresh_i}/{page_refreshes})",
                flush=True,
            )
            await _goto_signup_page(page, attempt)

        # Understand + drive to email form (handles CF, cookie, chooser, loading)
        st = await heal_to_stage(
            page,
            attempt,
            {"signup_email", "signup_otp", "signup_profile"},
            email_addr=email_addr,
            timeout_s=14.0,
        )
        stage = st.get("stage") or "unknown"
        vlog(f"signup DOM stage={stage} buttons={st.get('buttons', [])[:6]}", attempt)

        if stage in ("signup_otp", "signup_profile"):
            # Already past email — return any visible input sel for no-op fill path
            sel = await wait_for_selector_any(page, _SIGNUP_EMAIL_SELS, 1500)
            if sel:
                return sel
            # Synthetic: no email field needed
            return _SIGNUP_EMAIL_SELS[0]

        if stage == "signup_email" or st.get("emailIn"):
            emit_progress(attempt, "fill_email", "Filling registration email", email_addr)
            email_sel = await _wait_signup_email_input(page, attempt, timeout_s=8.0)
            if email_sel:
                return email_sel

        # Still wrong stage — chooser/CF residual
        emit_progress(attempt, "signup_email_btn", "Selecting Sign up with email", email_addr)
        await _click_signup_with_email(page, attempt)
        email_sel = await _wait_signup_email_input(page, attempt, timeout_s=8.0)
        if email_sel:
            return email_sel

    await screenshot(page, attempt, "no_email_input")
    try:
        st = await read_page_state(page)
        print(
            f"[{attempt}] signup give-up stage={st.get('stage')} "
            f"body={st.get('bodySample')!r}",
            flush=True,
        )
    except Exception:
        pass
    raise RecoverableFarmError(
        f"Could not reach signup_email after {page_refreshes} DOM-heal refresh(es) "
        f"— will re-spawn browser",
        delay_s=1.5,
        tag="NoEmailInput",
    )


async def do_signup(page, email_addr: str, password: str, attempt: int, mail_page=None) -> bool:
    # DOM-aware: reach signup_email (or already past it) before acting.
    email_sel = await _ensure_signup_email_ready(
        page, attempt, email_addr, page_refreshes=3,
    )
    st0 = await read_page_state(page)
    already_past_email = st0.get("stage") in ("signup_otp", "signup_profile", "account_home")

    if not already_past_email:
        filled = await fill_input(page, [email_sel] + _SIGNUP_EMAIL_SELS, email_addr)
        if not filled:
            print(f"[{attempt}] fill email failed — DOM-heal + retry fill", flush=True)
            emit_progress(attempt, "fill_email", "Fill failed — heal + retry", email_addr)
            await heal_to_stage(
                page, attempt, {"signup_email"}, email_addr=email_addr, timeout_s=10.0,
            )
            email_sel = await _wait_signup_email_input(page, attempt, timeout_s=8.0)
            filled = bool(email_sel) and await fill_input(
                page, [email_sel] + _SIGNUP_EMAIL_SELS, email_addr,
            )
            if not filled:
                await screenshot(page, attempt, "email_fill_fail")
                raise RecoverableFarmError(
                    "Failed to fill email after DOM heal — will re-spawn browser",
                    delay_s=1.5,
                    tag="EmailFillFail",
                )

        await asyncio.sleep(0.3)
        await handle_turnstile(page, attempt, max_wait=8)

        emit_progress(attempt, "submit_email", "Clicking Sign up", email_addr)
    else:
        vlog(f"signup already past email (stage={st0.get('stage')})", attempt)
        emit_progress(
            attempt, "fill_email",
            f"Skip email — already {st0.get('stage')}",
            email_addr,
        )

    otp_wait_started = time.time()

    async def _click_sign_up_submit() -> None:
        hit = await smart_click(
            page, ["Sign up"],
            exclude=["Google", "Apple", "email", "X", "with"],
            timeout_s=4.0,
            attempt=attempt,
        )
        if hit:
            return
        try:
            await page.locator('button[type="submit"]').filter(
                has_text=re.compile(r"^sign up$", re.I)
            ).click(timeout=4000)
        except Exception:
            await click_text_button(
                page, ["Sign up"], exclude=["Google", "Apple", "email", "X"]
            )

    async def _wait_otp_fields(timeout_ms: int = 15000) -> str | None:
        return await wait_for_selector_any(
            page,
            [
                'input[name="code"]',
                'input[autocomplete="one-time-code"]',
                'input[maxlength="1"]',
            ],
            timeout_ms,
        )

    if not already_past_email or (await read_page_state(page)).get("stage") not in (
        "signup_otp", "signup_profile",
    ):
        await _click_sign_up_submit()
        await asyncio.sleep(1.2)

    # Wait for OTP UI — DOM heal + soft-refresh before full browser restart
    st_otp = await heal_to_stage(
        page, attempt, {"signup_otp", "signup_profile"},
        email_addr=email_addr, timeout_s=10.0,
    )
    code_sel = None
    if st_otp.get("stage") == "signup_otp" or st_otp.get("otpIn"):
        code_sel = await _wait_otp_fields(8000)
    if not code_sel:
        code_sel = await _wait_otp_fields(12000)
    if not code_sel:
        await screenshot(page, attempt, "no_otp_input")
        await handle_turnstile(page, attempt, max_wait=12)
        await _click_sign_up_submit()
        code_sel = await _wait_otp_fields(12000)
    if not code_sel:
        # Domain reject? check before refresh
        try:
            body_text = await page.evaluate("document.body?.innerText || ''") or ""
        except Exception:
            body_text = ""
        m = re.search(
            r"email\s+domain\s+([A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z]{2,})\s+has\s+been\s+rejected",
            body_text, re.IGNORECASE,
        )
        if m:
            raise DomainRejectedError(m.group(1).strip().lower())
        # Soft-refresh page (keep email if form still there, else re-fill)
        await _page_soft_refresh(
            page, attempt, reason="OTP form missing", step="wait_otp", email_addr=email_addr,
        )
        # Re-open email path + re-submit if needed
        if await page.locator('input[type="email"], input[name="email"]').count() > 0:
            await fill_input(
                page,
                ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]'],
                email_addr,
            )
            await handle_turnstile(page, attempt, max_wait=8)
            await _click_sign_up_submit()
            await asyncio.sleep(1.5)
        code_sel = await _wait_otp_fields(15000)
    if not code_sel:
        await screenshot(page, attempt, "otp_input_missing")
        try:
            body_text = await page.evaluate("document.body?.innerText || ''") or ""
        except Exception:
            body_text = ""
        m = re.search(
            r"email\s+domain\s+([A-Za-z0-9][A-Za-z0-9.\-]*\.[A-Za-z]{2,})\s+has\s+been\s+rejected",
            body_text, re.IGNORECASE,
        )
        if m:
            raise DomainRejectedError(m.group(1).strip().lower())
        raise RecoverableFarmError(
            "OTP input never appeared after Sign up + page refresh",
            delay_s=2.0,
            tag="NoOtpInput",
        )

    if MAIL_MODE == "tempmail" and mail_page is not None:
        emit_progress(attempt, "wait_otp", "Waiting for xAI code via temp mail", email_addr)
        otp = await tempmail_read_otp(
            mail_page, email_addr, OTP_TIMEOUT_S, attempt
        )
    else:
        emit_progress(attempt, "wait_otp", "Waiting for xAI confirmation code via IMAP", email_addr)
        otp = await wait_otp_imap_keepalive(
            page, email_addr, OTP_TIMEOUT_S, otp_wait_started - 15, attempt
        )
    if not otp:
        await screenshot(page, attempt, "otp_timeout")
        # Soft-heal on BOTH browsers (signup page + this worker's mail page)
        await _page_soft_refresh(
            page, attempt, reason="OTP timeout — refresh signup page", step="wait_otp",
            email_addr=email_addr,
        )
        extra = 60
        if MAIL_MODE == "tempmail" and mail_page is not None:
            emit_progress(
                attempt, "tempmail_otp",
                f"[w{attempt}] extended poll +{extra}s after timeout",
                email_addr,
            )
            otp = await tempmail_read_otp(mail_page, email_addr, extra, attempt)
        else:
            otp = await wait_otp_imap_keepalive(
                page, email_addr, extra, otp_wait_started - 15, attempt
            )
        if not otp:
            raise RecoverableFarmError(
                f"OTP timeout after {OTP_TIMEOUT_S}s + mail self-heal "
                f"(worker {attempt} isolated)",
                delay_s=2.0,
                tag="OtpTimeout",
            )

    # UI is multi-box "XXX-XXX". Never value='' clear / never type hyphen.
    otp_clean = otp.strip().upper()
    otp_chars = re.sub(r"[^A-Z0-9]", "", otp_clean)
    if len(otp_chars) != 6:
        print(f"[{attempt}] WARN: unexpected OTP length {len(otp_chars)}: {otp_clean}", flush=True)

    async def _try_fill_otp() -> bool:
        emit_progress(attempt, "fill_otp", f"Entering code {otp}", email_addr)
        try:
            await dismiss_cookie_banner(page)
        except Exception:
            pass
        await asyncio.sleep(0.3)
        if not await _otp_inputs_ready(page):
            await _wait_otp_fields(8000)
        try:
            return await asyncio.wait_for(
                fill_xai_otp_boxes(page, otp_chars, attempt),
                timeout=35.0,
            )
        except asyncio.TimeoutError:
            return False

    otp_filled = await _try_fill_otp()
    if not otp_filled:
        await screenshot(page, attempt, "otp_fill_fail")
        # Soft-refresh + re-enter same OTP (code is still valid)
        await _page_soft_refresh(
            page, attempt, reason="OTP fill failed — refresh + retype",
            step="fill_otp", email_addr=email_addr,
        )
        otp_filled = await _try_fill_otp()
    if not otp_filled:
        await screenshot(page, attempt, "otp_fill_fail")
        if await _otp_form_broken(page):
            raise RecoverableFarmError(
                "OTP form broken after page refresh — will re-spawn browser",
                delay_s=1.5,
                tag="OtpFormBroken",
            )
        raise RecoverableFarmError(
            "Failed to enter OTP after page refresh — will re-spawn browser",
            delay_s=1.5,
            tag="OtpFillFail",
        )
    # NOTE: do NOT re-read DOM and hard-fail here. xAI React OTP often drops
    # visible input.value after accept while internal form state keeps the code.
    await asyncio.sleep(0.3)

    emit_progress(attempt, "confirm_email", "Confirming email", email_addr)
    try:
        await dismiss_cookie_banner(page)
    except Exception:
        pass

    async def _click_confirm() -> None:
        try:
            await page.get_by_role(
                "button", name=re.compile(r"confirm email", re.I)
            ).click(timeout=5000)
        except Exception:
            await click_text_button(
                page, ["Confirm email", "Confirm Email", "Confirm", "Verify"]
            )

    await _click_confirm()
    await asyncio.sleep(1.5)

    # Fail-fast with one soft-refresh if still stuck on Verify
    confirm_deadline = time.monotonic() + CONFIRM_EMAIL_TIMEOUT_S
    soft_refreshed_confirm = False
    try:
        while time.monotonic() < confirm_deadline:
            still_verify = await page.locator("text=Verify your email").count()
            if still_verify == 0:
                break
            err = await page.locator(
                "text=/expected string, received undefined|Invalid input|incorrect|expired|try again/i"
            ).count()
            if err > 0:
                await screenshot(page, attempt, "otp_invalid")
                if not soft_refreshed_confirm:
                    soft_refreshed_confirm = True
                    await _page_soft_refresh(
                        page, attempt, reason="OTP rejected — refresh + retype",
                        step="confirm_email", email_addr=email_addr,
                    )
                    await _try_fill_otp()
                    await _click_confirm()
                    await asyncio.sleep(1.2)
                    continue
                raise RecoverableFarmError(
                    "OTP rejected by form after page refresh",
                    delay_s=1.5,
                    tag="OtpRejected",
                )
            try:
                await page.get_by_role(
                    "button", name=re.compile(r"confirm email", re.I)
                ).click(timeout=2500)
            except Exception:
                pass
            await asyncio.sleep(1.5)
        else:
            await screenshot(page, attempt, "confirm_stuck")
            if not soft_refreshed_confirm:
                soft_refreshed_confirm = True
                await _page_soft_refresh(
                    page, attempt, reason="confirm stuck — refresh + retype OTP",
                    step="confirm_email", email_addr=email_addr,
                )
                await _try_fill_otp()
                await _click_confirm()
                await asyncio.sleep(2.0)
                if await page.locator("text=Verify your email").count() == 0:
                    pass  # recovered
                else:
                    raise RecoverableFarmError(
                        f"confirm_email stuck >{CONFIRM_EMAIL_TIMEOUT_S}s after refresh",
                        delay_s=2.0,
                        tag="ConfirmStuck",
                    )
            else:
                raise RecoverableFarmError(
                    f"confirm_email stuck >{CONFIRM_EMAIL_TIMEOUT_S}s (still on Verify page)",
                    delay_s=2.0,
                    tag="ConfirmStuck",
                )
    except RecoverableFarmError:
        raise
    except Exception as e:
        if time.monotonic() >= confirm_deadline:
            await screenshot(page, attempt, "confirm_error")
            raise RecoverableFarmError(
                f"confirm_email error after timeout: {e}",
                delay_s=2.0,
                tag="ConfirmError",
            ) from e

    # Profile: first / last / password (probed live)
    first, last = random_name()
    emit_progress(attempt, "profile", f"Filling profile {first} {last}", email_addr)
    await screenshot(page, attempt, "profile_step")

    # Dump inputs for debug if fill fails
    profile_ready = await wait_for_selector_any(
        page,
        [
            'input[name*="first" i]',
            'input[autocomplete="given-name"]',
            'input[name="given_name"]',
            'input[type="password"]',
            'input[name*="name" i]',
        ],
        15000,
    )
    if not profile_ready:
        await screenshot(page, attempt, "no_profile")
        # might already be past profile / logged in — continue to OAuth path
        print(f"[{attempt}] Profile form not found — checking page state", flush=True)
    else:
        # Try common name field patterns (xAI may use firstName/lastName)
        await fill_input(
            page,
            [
                'input[name="firstName"]',
                'input[name="first_name"]',
                'input[name="given_name"]',
                'input[name*="first" i]',
                'input[autocomplete="given-name"]',
                'input[placeholder*="First" i]',
            ],
            first,
        )
        await asyncio.sleep(0.25)
        await fill_input(
            page,
            [
                'input[name="lastName"]',
                'input[name="last_name"]',
                'input[name="family_name"]',
                'input[name*="last" i]',
                'input[autocomplete="family-name"]',
                'input[placeholder*="Last" i]',
            ],
            last,
        )
        await asyncio.sleep(0.25)
        # If only a single "Name" field
        try:
            name_inputs = await page.locator(
                'input[name="name"], input[autocomplete="name"], input[placeholder*="Name" i]'
            ).all()
            if name_inputs and not await page.locator('input[name*="first" i]').count():
                await name_inputs[0].fill(f"{first} {last}")
        except Exception:
            pass

        # Prefer React-safe fill (triggers turnstile mount after password input)
        await _ensure_password_filled(page, password, attempt)
        await asyncio.sleep(0.8)  # allow CF widget to mount after password

        # ── Complete sign-up (DOM-aware) ────────────────────────────────
        # Research + logs: Turnstile often SOLVES (token_len~645) then form
        # stays put because password was wiped / submit didn't hit React /
        # we only checked "Complete your sign up" text. Soft-refresh AFTER
        # a good token DESTROYS the token → long stuck loops. Fix:
        #   1) read form state (fields + ts token)
        #   2) solve CF only if token missing
        #   3) light re-fill after CF (pw only if names already set)
        #   4) multi-wave submit + strict success (no soft-reload trap)
        #   5) never full-reload after token-burn; re-solve CF instead
        emit_progress(attempt, "complete_signup", "Turnstile + Complete (DOM)", email_addr)
        completed = False
        complete_deadline = time.monotonic() + COMPLETE_SIGNUP_TIMEOUT_S
        round_i = 0
        soft_refreshed_complete = False
        ever_had_token = False
        submit_burns = 0  # token present → submit → ts=0 while still on form
        while time.monotonic() < complete_deadline and not completed:
            round_i += 1
            remaining = max(3.0, complete_deadline - time.monotonic())
            if await _complete_form_succeeded(page):
                completed = True
                break

            st = await _read_complete_form_state(page)
            tok = int(st.get("tsLen") or 0)
            pw_len = int(st.get("pwLen") or 0)
            if tok > 20:
                ever_had_token = True
            emit_progress(
                attempt,
                "complete_signup",
                f"r{round_i} ts={tok} pw={pw_len} "
                f"{'err' if st.get('err') else 'ok'}",
                email_addr,
            )

            # Step A: ensure profile fields filled
            if pw_len < 4 or not (st.get("first") or "").strip() or not (st.get("last") or "").strip():
                st = await _refill_complete_profile(
                    page, first, last, password, attempt
                )
                tok = int(st.get("tsLen") or 0)
                pw_len = int(st.get("pwLen") or 0)

            # Step B: solve Turnstile only when token missing
            if tok <= 20:
                # Trace first — may already be solved/loading without remount
                ts0 = await read_turnstile_state(page)
                print(
                    f"[{attempt}] complete r{round_i} pre: phase={ts0.get('phase')} "
                    f"token_len={ts0.get('token_len')} success_ui={ts0.get('success_ui')}",
                    flush=True,
                )
                emit_progress(
                    attempt, "complete_signup",
                    f"r{round_i} TS {ts0.get('phase')} tok={ts0.get('token_len')}",
                    email_addr,
                )
                # Only remount if failed or stuck need_click after r2+
                if ts0.get("phase") == "failed" or (
                    round_i >= 3 and ts0.get("phase") == "need_click" and not ever_had_token
                ):
                    await _force_turnstile_remount(
                        page, attempt, password,
                        hard=(round_i >= 4 and not ever_had_token),
                    )
                    st = await _refill_complete_profile(
                        page, first, last, password, attempt
                    )
                # Longer slice so wait_for_turnstile (5–10s) can settle after click
                slice_wait = min(20.0, remaining)
                ok_ts = await handle_turnstile(
                    page,
                    attempt,
                    max_wait=slice_wait,
                    require_token=True,
                    password=password,
                    allow_remount=True,
                )
                tsf = await read_turnstile_state(page)
                tok = int(tsf.get("token_len") or await turnstile_token_len(page) or 0)
                print(
                    f"[{attempt}] complete r{round_i}: turnstile_ok={ok_ts} "
                    f"phase={tsf.get('phase')} token_len={tok} "
                    f"success_ui={tsf.get('success_ui')} "
                    f"mounted={await _turnstile_mount_present(page)}",
                    flush=True,
                )
                # CF solve often remounts form → wipe password — re-fill carefully
                # Full name re-type can remount CF and burn a fresh token; only
                # refill what is empty, then re-check token immediately before submit.
                st = await _read_complete_form_state(page)
                need_full = (
                    int(st.get("pwLen") or 0) < 4
                    or not (st.get("first") or "").strip()
                    or not (st.get("last") or "").strip()
                )
                if need_full:
                    st = await _refill_complete_profile(
                        page, first, last, password, attempt
                    )
                else:
                    await _ensure_password_filled(page, password, attempt)
                    st = await _read_complete_form_state(page)
                tok = int(st.get("tsLen") or await turnstile_token_len(page) or 0)
                pw_len = int(st.get("pwLen") or 0)
                if tok > 20:
                    ever_had_token = True
                # Still zero after slice: click slot + frame again once, short wait
                if tok <= 20:
                    await try_click_turnstile(page, attempt)
                    await _click_turnstile_slot_above_complete(page, attempt)
                    await asyncio.sleep(1.5)
                    tok = await turnstile_token_len(page)
                    if tok > 20:
                        ever_had_token = True
            else:
                print(
                    f"[{attempt}] complete r{round_i}: reuse token_len={tok} "
                    f"pw={pw_len} (no CF re-solve)",
                    flush=True,
                )
                # Token still good — only touch password if empty (avoid CF remount)
                if pw_len < 4:
                    await _ensure_password_filled(page, password, attempt)
                    st = await _read_complete_form_state(page)
                    tok = int(st.get("tsLen") or await turnstile_token_len(page) or 0)
                    pw_len = int(st.get("pwLen") or 0)

            time_left = complete_deadline - time.monotonic()
            if tok <= 20 and time_left > 10:
                print(
                    f"[{attempt}] no Turnstile token yet — remount cycle "
                    f"(left {time_left:.0f}s burns={submit_burns})",
                    flush=True,
                )
                # Don't idle 25s on ts=0 — remount; hard only if never solved
                await _force_turnstile_remount(
                    page, attempt, password,
                    hard=(round_i >= 3 and not ever_had_token),
                )
                await _refill_complete_profile(page, first, last, password, attempt)
                await asyncio.sleep(0.8)
                continue
            if pw_len < 4 and time_left > 8:
                print(f"[{attempt}] password empty — re-fill", flush=True)
                await _ensure_password_filled(page, password, attempt)
                continue

            # Step C: submit while token+password present (verify token still live)
            tok = await turnstile_token_len(page)
            if tok <= 20:
                continue
            # Wait for React to enable Complete after CF token lands
            bst = await _wait_complete_button_ready(page, max_wait=2.5)
            print(
                f"[{attempt}] complete r{round_i}: submit ts={tok} pw={pw_len} "
                f"btn_disabled={bst.get('disabled')} covered={bst.get('covered')} "
                f"found={bst.get('found')}",
                flush=True,
            )
            tok = await turnstile_token_len(page)
            if tok <= 20:
                print(f"[{attempt}] token vanished before submit — re-solve", flush=True)
                continue

            # Network truth: only mutating signup/identity APIs (not static assets)
            api_hit = {"kind": "ignore", "url": "", "status": 0, "method": ""}

            def _on_signup_resp(resp) -> None:
                try:
                    u = resp.url or ""
                    code = int(resp.status or 0)
                    method = ""
                    try:
                        method = (resp.request.method or "") if resp.request else ""
                    except Exception:
                        method = ""
                    kind = classify_signup_api_response(u, code, method)
                    if kind == "ignore":
                        return
                    # Prefer first non-ignore; upgrade ignore→err/ok, keep err if later ok race
                    if api_hit["kind"] == "ignore" or (
                        api_hit["kind"] == "err" and kind == "ok"
                    ):
                        api_hit["kind"] = kind
                        api_hit["url"] = u[:120]
                        api_hit["status"] = code
                        api_hit["method"] = method
                except Exception:
                    pass

            left_ok = False
            try:
                page.on("response", _on_signup_resp)
            except Exception:
                pass
            try:
                # expect_response + multi-wave submit (do not double-submit on timeout)
                submitted = False
                try:
                    async with page.expect_response(
                        lambda r: classify_signup_api_response(
                            r.url,
                            int(r.status or 0),
                            (r.request.method if r.request else "") or "",
                        )
                        != "ignore",
                        timeout=9000,
                    ) as resp_info:
                        await _submit_complete_signup(page, attempt)
                        submitted = True
                    try:
                        resp = await resp_info.value
                        method = ""
                        try:
                            method = (resp.request.method or "") if resp.request else ""
                        except Exception:
                            pass
                        kind = classify_signup_api_response(
                            resp.url, int(resp.status or 0), method
                        )
                        api_hit["kind"] = kind
                        api_hit["url"] = (resp.url or "")[:120]
                        api_hit["status"] = int(resp.status or 0)
                        api_hit["method"] = method
                    except Exception:
                        pass
                except Exception as exp_e:
                    # Timeout: action inside with-block usually already ran
                    if not submitted:
                        await _submit_complete_signup(page, attempt)
                        submitted = True
                    vlog(
                        f"complete: expect_response note {type(exp_e).__name__}: "
                        f"{str(exp_e)[:80]}",
                        attempt,
                    )

                for _ in range(16):
                    await asyncio.sleep(0.4)
                    if await _complete_form_succeeded(page):
                        left_ok = True
                        break
                    # API ok alone is NOT enough while complete form still visible
                    # (hellverg: noisy api_hit with form stuck). Require left form.
                    if (
                        api_hit["kind"] == "ok"
                        and not await _on_complete_signup_form(page)
                    ):
                        left_ok = True
                        break
            finally:
                try:
                    page.remove_listener("response", _on_signup_resp)
                except Exception:
                    pass
            if left_ok:
                completed = True
                print(
                    f"[{attempt}] complete: left form (success) "
                    f"api={api_hit['kind']} {api_hit['status']} "
                    f"{api_hit['method']} {api_hit['url'][:60]}",
                    flush=True,
                )
                break

            st2 = await _read_complete_form_state(page)
            tok2 = int(st2.get("tsLen") or 0)
            body_snip = ""
            try:
                body_snip = (await page.inner_text("body"))[:180].replace("\n", " ")
            except Exception:
                pass
            aria_dis = bool(
                st2.get("btnDisabledAria")
                or (st2.get("aria") or {}).get("completeDisabled")
            )
            print(
                f"[{attempt}] still on complete after submit "
                f"ts={tok2} pw={st2.get('pwLen')} err={st2.get('err')} "
                f"api={api_hit['kind']}:{api_hit['status']}:{api_hit['method']} "
                f"aria_disabled={aria_dis} "
                f"btn={await _complete_button_state(page)} "
                f"body={body_snip!r}",
                flush=True,
            )
            # Token still live → multi-wave already ran; light pw nudge + one more
            if tok2 > 20:
                if int(st2.get("pwLen") or 0) < 4:
                    await _ensure_password_filled(page, password, attempt)
                await _wait_complete_button_ready(page, max_wait=1.5)
                await _submit_complete_signup(page, attempt)
                for _ in range(10):
                    await asyncio.sleep(0.4)
                    if await _complete_form_succeeded(page):
                        completed = True
                        break
                if completed:
                    break
            else:
                # Token burned, still on form = failed accept (server/React).
                # Do NOT soft-reload (destroys session + false "left form").
                # Re-solve CF next loop. Soft-refresh only if CF never mounted.
                submit_burns += 1
                print(
                    f"[{attempt}] complete: token burn #{submit_burns} "
                    f"api={api_hit['kind']}:{api_hit['status']} "
                    f"(re-solve, no page reload)",
                    flush=True,
                )
                # Fail-fast: 3 burns with CF that does solve → re-spawn, don't sit 120s
                if submit_burns >= 3 and ever_had_token:
                    await screenshot(page, attempt, "complete_token_burn")
                    raise RecoverableFarmError(
                        f"complete_signup token burned {submit_burns}x "
                        f"(api={api_hit['kind']}:{api_hit['status']} "
                        f"err={st2.get('err')} aria_disabled={aria_dis}) "
                        f"— re-spawn browser",
                        delay_s=2.0,
                        tag="CompleteTokenBurn",
                    )
                if (
                    not soft_refreshed_complete
                    and not ever_had_token
                    and round_i >= 3
                    and not st2.get("tsIframe")
                    and remaining < COMPLETE_SIGNUP_TIMEOUT_S * 0.35
                ):
                    soft_refreshed_complete = True
                    await _page_soft_refresh(
                        page, attempt,
                        reason="complete: Turnstile never mounted — reload form",
                        step="complete_signup",
                        email_addr=email_addr,
                    )
                    # After reload, only continue if still on complete profile
                    if not await _on_complete_signup_form(page):
                        print(
                            f"[{attempt}] complete: post-reload not on form "
                            f"(stage trap) — fail closed",
                            flush=True,
                        )
                        break
                    await _refill_complete_profile(page, first, last, password, attempt)

        if not completed:
            if await _complete_form_succeeded(page):
                completed = True
            else:
                await screenshot(page, attempt, "complete_stuck")
                stf = await _read_complete_form_state(page)
                raise RecoverableFarmError(
                    f"complete_signup stuck >{COMPLETE_SIGNUP_TIMEOUT_S}s "
                    f"(ts={stf.get('tsLen')} pw={stf.get('pwLen')} "
                    f"onComplete={stf.get('onComplete')} burns={submit_burns} "
                    f"ever_ts={ever_had_token})",
                    delay_s=2.0,
                    tag="CompleteStuck",
                )

    await screenshot(page, attempt, "after_signup")
    return True


async def _password_field_value(page) -> str:
    try:
        return await page.evaluate(
            """() => {
                const el = document.querySelector('input[type="password"], input[name="password"], input[autocomplete="current-password"]');
                return el && typeof el.value === 'string' ? el.value : '';
            }"""
        ) or ""
    except Exception:
        return ""


async def _wait_password_ready(page, attempt: int, max_wait: float = 8.0) -> None:
    """After password fill, wait briefly for Turnstile mount (do not block on eye-icon SVG)."""
    deadline = time.monotonic() + max_wait
    while time.monotonic() < deadline:
        if await turnstile_token_len(page) > 20:
            return
        if await turnstile_visible(page):
            await asyncio.sleep(0.4)
            return
        if await _turnstile_mount_present(page):
            await asyncio.sleep(0.8)  # give iframe a moment to init
            return
        await asyncio.sleep(0.35)
    # not fatal — handle_turnstile will keep trying


async def _ensure_password_filled(page, password: str, attempt: int) -> bool:
    """Fill password only when empty — skip re-typing if already present.

    Re-entering every round remounts React/CF and wastes time; only fill when wiped.
    """
    if await page.locator('input[type="password"]').count() == 0:
        return True  # password step not shown

    # Already filled? Do not re-type (avoids CF remount + wasted seconds).
    existing = await _password_field_value(page)
    if existing and len(existing) >= min(4, len(password or "") or 4):
        vlog(f"password already filled (len={len(existing)}) — skip re-enter", attempt)
        return True

    for try_i in range(3):
        if await page.locator('input[type="password"]').count() == 0:
            return True
        await fill_input(
            page,
            [
                'input[type="password"]',
                'input[name="password"]',
                'input[autocomplete="current-password"]',
                'input[autocomplete="new-password"]',
            ],
            password,
        )
        await asyncio.sleep(0.25)
        try:
            loc = page.locator('input[type="password"]').first
            if await loc.count() > 0:
                val = await loc.input_value()
                if not val:
                    await loc.click()
                    await loc.fill(password)
                    await asyncio.sleep(0.2)
                    val = await loc.input_value()
                if val:
                    try:
                        await loc.evaluate("el => el.blur()")
                    except Exception:
                        pass
                    await _wait_password_ready(page, attempt, max_wait=10.0)
                    return True
        except Exception:
            pass
        val = await _password_field_value(page)
        if val:
            await _wait_password_ready(page, attempt, max_wait=8.0)
            return True
        print(f"[{attempt}] password empty after fill (try {try_i+1})", flush=True)
        await asyncio.sleep(0.4)
    return bool(await _password_field_value(page))


async def recover_page_load_error(page, attempt: int) -> bool:
    """Handle Firefox 'This page couldn't load' (network blip / concurrent stress)."""
    try:
        body = (await page.inner_text("body"))[:500].lower()
    except Exception:
        body = ""
    if "couldn't load" not in body and "could not load" not in body and "page isn’t available" not in body:
        # also check title-ish
        if "reload" not in body or "try again" not in body:
            return False
        if "couldn't" not in body and "could not" not in body and "can't be reached" not in body:
            return False
    print(f"[{attempt}] page load error detected — reloading", flush=True)
    try:
        btn = page.get_by_role("button", name=re.compile(r"reload", re.I))
        if await btn.count() > 0:
            await btn.first.click(timeout=3000)
        else:
            await page.reload(wait_until="domcontentloaded", timeout=45000)
        await asyncio.sleep(2.0)
        return True
    except Exception as e:
        print(f"[{attempt}] reload failed: {e}", flush=True)
        try:
            await page.reload(wait_until="domcontentloaded", timeout=45000)
            await asyncio.sleep(2.0)
            return True
        except Exception:
            return False


async def click_login_with_email(page) -> bool:
    """xAI login chooser — multi-locale (detect UI lang first)."""
    lang = await detect_page_ui_lang(page)
    labels = ui_labels("login_with_email", lang)
    clicked = await click_text_button(
        page,
        labels,
        exclude=["Google", "Apple", "Microsoft", " with X", " with x", "使用 Google", "使用 Apple"],
    )
    if clicked:
        return True
    try:
        await page.get_by_role(
            "button",
            name=re.compile(
                r"(log\s*in|sign\s*in|masuk|登录|登入|ログイン|로그인|entrar|connexion|"
                r"anmelden|giriş|войти|đăng\s*nhập|เข้าสู่ระบบ).{0,12}"
                r"(email|e-?mail|邮箱|郵件|メール|correo|почт)",
                re.I,
            ),
        ).click(timeout=4000)
        return True
    except Exception:
        pass
    try:
        hit = await page.evaluate(
            """() => {
              const reMail = /email|e-?mail|邮箱|郵件|メール|이메일|correo|почт|อีเมล|بريد|e-posta/i;
              const reLogin = /log\\s*in|sign\\s*in|masuk|登录|登入|ログイン|로그인|entrar|connexion|anmelden|giriş|войти|đăng\\s*nhập|เข้าสู่ระบบ|accedi|inloggen/i;
              const skip = /google|apple|microsoft/i;
              for (const b of document.querySelectorAll('button, a[role="button"]')) {
                const t = (b.innerText || '').trim();
                if (!t || t.length > 80) continue;
                if (skip.test(t) && !reMail.test(t)) continue;
                if (reMail.test(t) && reLogin.test(t)) { b.click(); return t.slice(0, 40); }
              }
              return '';
            }"""
        )
        return bool(hit)
    except Exception:
        return False


async def drive_email_password_login(page, email_addr: str, password: str, attempt: int,
                                     *, rounds: int = 5, ts_max_wait: float = 22.0,
                                     post_click_sleep: float = 2.5,
                                     use_global_limit: bool = False) -> bool:
    """Drive accounts.x.ai email login form (Next → password → Turnstile → Login).

    Same email as registration is re-entered (NOT a change-email step). xAI OAuth
    often starts a fresh sign-in even right after signup.

    Password: fill once; after Turnstile only re-fill if the field was wiped
    (do not re-type every round).

    use_global_limit=False (default): each browser solves Turnstile independently —
    workers never wait on each other (same isolation as refresh).
    use_global_limit=True: optional serialize via TURNSTILE_PARALLEL (legacy; only
    if you explicitly want one CF solve at a time on a shared IP).
    """
    await dismiss_cookie_banner(page)
    await recover_page_load_error(page, attempt)

    # Provider chooser may still be showing
    if await page.locator("text=/Log( ?in|in) with email|Sign in with email/i").count() > 0:
        if await page.locator('input[type="email"], input[type="password"]').count() == 0:
            await click_login_with_email(page)
            await asyncio.sleep(1.0)

    # Step: email (same farmed address — re-auth, not "ganti email")
    if await page.locator('input[type="email"], input[name="email"]').count() > 0:
        await fill_input(
            page,
            ['input[type="email"]', 'input[name="email"]', 'input[autocomplete="email"]'],
            email_addr,
        )
        await asyncio.sleep(0.3)
        # Next only when password not yet visible — wait out loading spinner
        if await page.locator('input[type="password"]').count() == 0:
            try:
                await page.get_by_role("button", name=re.compile(r"^next$", re.I)).click(timeout=4000)
            except Exception:
                await click_text_button(page, ["Next", "Continue"], exclude=["Google", "Apple"])
            # Wait for password field (not just fixed sleep — Next can hang on network)
            for _ in range(20):
                await recover_page_load_error(page, attempt)
                if await page.locator('input[type="password"]').count() > 0:
                    break
                await asyncio.sleep(0.5)
            await asyncio.sleep(0.4)

    # Step: password first (before turnstile)
    if not await _ensure_password_filled(page, password, attempt):
        vlog("WARN: could not fill password before turnstile", attempt)

    for round_i in range(rounds):
        # EARLY EXIT: if we're already on /account, login succeeded — stop
        # immediately, don't grind through more Turnstile rounds. This is the
        # big speedup: xAI lands on /account as soon as the login click works,
        # but the old code kept solving Turnstile + re-clicking for the full
        # round count.
        try:
            cur = (page.url or "")
        except Exception:
            cur = ""
        if cur.rstrip("/").endswith("accounts.x.ai/account"):
            vlog("login: already on /account — login succeeded, skipping remaining rounds", attempt)
            return True
        await recover_page_load_error(page, attempt)

        # Still on provider chooser?
        if await page.locator('input[type="password"]').count() == 0 and await page.locator(
            "text=/Login with email|Log in with email|Sign in with email/i"
        ).count() > 0:
            await click_login_with_email(page)
            await asyncio.sleep(1.0)
            continue

        # 1) Solve / confirm turnstile if present (throttle + remount on fail)
        needs_ts = (
            await turnstile_visible(page)
            or await page.locator("text=Verify you are human").count() > 0
            or await _turnstile_mount_present(page)
            or await _turnstile_verification_failed(page)
        )
        if needs_ts:
            ts_pre = await read_turnstile_state(page)
            if ts_pre.get("solved"):
                print(
                    f"[{attempt}] login: Turnstile already solved "
                    f"(token_len={ts_pre.get('token_len')}) — skip re-click",
                    flush=True,
                )
            else:
                emit_progress(
                    attempt,
                    "login",
                    f"Turnstile · try {round_i + 1}/{rounds} "
                    f"phase={ts_pre.get('phase')}",
                    email_addr,
                )
                await handle_turnstile(
                    page,
                    attempt,
                    max_wait=ts_max_wait,
                    require_token=True,
                    password=password,
                    use_global_limit=use_global_limit,
                )
                ts_post = await read_turnstile_state(page)
                print(
                    f"[{attempt}] login TS after try {round_i + 1}: "
                    f"phase={ts_post.get('phase')} token_len={ts_post.get('token_len')} "
                    f"success_ui={ts_post.get('success_ui')}",
                    flush=True,
                )

        # 2) Re-fill password only if CF wipe emptied it (skip if still filled)
        pw_now = await _password_field_value(page)
        if not pw_now:
            if not await _ensure_password_filled(page, password, attempt):
                vlog(f"password still empty after turnstile (round {round_i+1})", attempt)
                await asyncio.sleep(0.5)
                continue
            pw_now = await _password_field_value(page)

        # 3) Click Login only when password non-empty + token ok (or no mount)
        tok_now = await turnstile_token_len(page)
        if not pw_now:
            continue
        if tok_now <= 20 and await _turnstile_mount_present(page):
            vlog(f"login: waiting for turnstile token (round {round_i+1})", attempt)
            await asyncio.sleep(1.0)
            continue
        vlog(
            f"login submit round {round_i+1} (pw_len={len(pw_now)}, ts={tok_now})",
            attempt,
        )
        try:
            await page.get_by_role("button", name=re.compile(r"^(login|log in|sign in)$", re.I)).click(timeout=4000)
        except Exception:
            await click_text_button(page, ["Login", "Log in", "Sign in", "Continue"])
        await asyncio.sleep(post_click_sleep)

        # Logged in? Check DIRECTLY by URL — don't rely on fragile element counts.
        # xAI lands on /account (or /oauth2/consent) the instant login works.
        # Wait up to 8s for that navigation, polling every 0.5s, so we catch it
        # FAST instead of burning a full extra round (~50s).
        login_done = False
        nav_deadline = time.monotonic() + 8.0
        while time.monotonic() < nav_deadline:
            try:
                u = (page.url or "").rstrip("/")
            except Exception:
                u = ""
            if (u.endswith("accounts.x.ai/account")
                    or "/oauth2/consent" in u
                    or "127.0.0.1:56121" in u
                    or "localhost:56121" in u):
                login_done = True
                break
            # password field vanished = login form gone = success
            if await page.locator('input[type="password"]').count() == 0 and "sign-in" in u:
                login_done = True
                break
            await asyncio.sleep(0.5)
        if login_done:
            vlog("login: success detected (left login form)", attempt)
            return True

        # Auth error?
        try:
            if await page.locator("text=/incorrect|invalid password|wrong password/i").count() > 0:
                vlog("login rejected (wrong password?)", attempt)
                await _ensure_password_filled(page, password, attempt)
        except Exception:
            pass
    return False


async def do_email_login(page, email_addr: str, password: str, attempt: int,
                         *, fast: bool = True) -> bool:
    """Login with email+password on accounts.x.ai if not already sessioned.

    fast=True (default): skip when already on /account; else 1 Turnstile try
    (≤15s) + early /account exit — not the old 2×12s HUD "round 1/2" grind.
    OAuth re-drives login if this returns False (independent path).
    """
    emit_progress(attempt, "login", "Email login (post-signup)", email_addr)
    try:
        cur = page.url or ""
    except Exception:
        cur = ""

    # Already on account after complete signup — skip full login (big speedup).
    if cur.rstrip("/").endswith("accounts.x.ai/account"):
        vlog("Already on /account — skip post-signup login", attempt)
        emit_progress(attempt, "login", "Already on /account — skip", email_addr)
        return True
    if "/oauth2/consent" in cur or "127.0.0.1:56121" in cur:
        return True

    # If still on complete signup, try finishing there first
    if await page.locator("text=Complete your sign up").count() > 0:
        vlog("Still on complete signup — finishing before login", attempt)
        return True  # caller already tried; OAuth will re-login

    # Session cookies?
    try:
        cookies = await page.context.cookies()
        has_sess = any(
            any(k in (c.get("name") or "").lower() for k in ("session", "auth", "token", "sid"))
            for c in cookies
        )
        if has_sess and "sign-in" not in cur and "sign-up" not in cur:
            vlog("Session cookies present — skip explicit login", attempt)
            emit_progress(attempt, "login", "Session OK — skip login", email_addr)
            return True
    except Exception:
        pass

    if "sign-in" not in cur and await page.locator('input[type="password"]').count() == 0:
        await page.goto(SIGNIN_URL, wait_until="domcontentloaded", timeout=45000)
        await asyncio.sleep(1.0)

    await dismiss_cookie_banner(page)
    await recover_page_load_error(page, attempt)
    # Prefer email path on provider chooser ("Login with email" on OAuth)
    await click_login_with_email(page)
    await asyncio.sleep(0.6)
    # fast: 1 primary Turnstile cycle (refer-ish patience without 5×22s).
    # Second round only if first submit didn't leave the form.
    ok = await drive_email_password_login(
        page, email_addr, password, attempt,
        rounds=2 if fast else 5,
        ts_max_wait=15.0 if fast else 22.0,
        post_click_sleep=1.0 if fast else 2.5,
        use_global_limit=False,
    )
    await screenshot(page, attempt, "after_login")
    return ok


# Hard ban list — never click these during OAuth consent (Deny was hit via cookie path)
_OAUTH_CONSENT_EXCLUDE = [
    "Google", "Apple", "Microsoft", "Deny", "Cancel", "Go back", "Reject",
    "Decline", "Refuse", "Sign out", "Sign Out", "Log out", "Logout",
    "Login with email", "Log in with email", "Sign in with email",
    "Sign up with email", "Continue with email",
    "使用邮箱", "登录", "登出", "退出", "Masuk", "Keluar", "Tolak",
]


def _is_oauth_allow_label(txt: str) -> bool:
    """True only for Allow/Authorize — never Deny, Accept, Continue, Sign out."""
    t = (txt or "").strip()
    if not t or len(t) > 48:
        return False
    low = t.lower()
    ban = (
        "deny", "reject", "decline", "refuse", "cancel", "go back",
        "accept", "continue", "agree",  # cookie / wrong CTAs
        "sign out", "log out", "logout", "sign-out",
        "login with", "log in with", "sign in with", "sign up with",
        "continue with", "google", "apple",
        "登出", "退出", "keluar", "tolak",
    )
    if any(b in low for b in ban):
        return False
    if re.match(r"^(allow|authorize|approve)(\s+access)?$", low):
        return True
    if re.match(
        r"^(允许|允許|benarkan|izinkan|permitir|autoriser|zulassen|"
        r"許可|허용|อนุญาต|cho phép|سماح|izin ver|разрешить|"
        r"zezwól|дозволити)$",
        t,
        re.I,
    ):
        return True
    if re.match(r"^allow\b", low) and "email" not in low and "sign" not in low:
        return True
    if re.match(r"^authorize\b", low) and "email" not in low:
        return True
    return False


async def click_oauth_consent_allow(page, attempt: int) -> str | None:
    """Click OAuth **Allow** only (refer-style). Never Deny / Accept / Continue.

    Accept/Continue are cookie/login CTAs and caused Deny/wrong clicks.
    """
    await dismiss_cookie_banner(page)

    # ONLY Allow / Authorize class — never Accept/Continue/Agree/Deny
    allow_names = [
        "Allow",
        "Authorize",
        "Approve",
        "Allow access",
        "允许",
        "允許",
        "Benarkan",
        "Izinkan",
        "Permitir",
        "Autoriser",
        "Zulassen",
        "許可",
        "허용",
        "อนุญาต",
        "Cho phép",
        "Разрешить",
        "Toestaan",
        "Zezwól",
    ]
    for name in allow_names:
        try:
            loc = page.get_by_role("button", name=re.compile(rf"^{re.escape(name)}$", re.I))
            if await loc.count() == 0:
                continue
            btn = loc.first
            if not await btn.is_visible():
                continue
            txt = (await btn.inner_text()).strip()
            if not _is_oauth_allow_label(txt):
                continue
            # Double-check not Deny (Playwright name match can be weird)
            if re.search(r"deny|reject|decline|tolak|拒绝", txt, re.I):
                continue
            try:
                await btn.click(timeout=4000, force=True)
            except Exception:
                await btn.click(timeout=3000, force=True)
            print(f"[{attempt}] OAuth Allow: {txt!r}", flush=True)
            return txt
        except Exception:
            continue

    # refer-style text — Allow/Authorize only + hard exclude Deny
    hit = await click_text_button(
        page,
        ["Allow", "Authorize", "Approve", "允许", "允許", "Benarkan", "Izinkan", "許可", "허용"],
        exclude=_OAUTH_CONSENT_EXCLUDE + [
            "Deny", "Reject", "Decline", "Accept", "Continue", "Agree",
            "Accept All", "Reject All",
        ],
    )
    if hit and _is_oauth_allow_label(hit) and not re.search(r"deny|reject", hit, re.I):
        print(f"[{attempt}] OAuth Allow (text): {hit!r}", flush=True)
        return hit
    if hit:
        print(f"[{attempt}] OAuth refused wrong button: {hit!r}", flush=True)

    # Strict JS: only exact Allow/Authorize — never Accept/Continue/Deny
    try:
        js_hit = await page.evaluate(
            """() => {
              const bad = /deny|reject|decline|refuse|cancel|accept|continue|agree|sign\\s*out|log\\s*out|login|sign\\s*in|email|google|apple|tolak|拒绝/i;
              const good = /^(allow|authorize|approve)(\\s+access)?$/i;
              const goodI18n = /^(允许|允許|benarkan|izinkan|permitir|autoriser|zulassen|許可|허용|อนุญาต|cho phép|سماح|izin ver|разрешить)$/i;
              const btns = [...document.querySelectorAll('button, [role="button"], input[type="submit"]')];
              let best = null;
              for (const b of btns) {
                const t = (b.innerText || b.textContent || b.value || '').trim();
                if (!t || t.length > 40 || bad.test(t)) continue;
                if (!(good.test(t) || goodI18n.test(t))) continue;
                const r = b.getBoundingClientRect();
                if (r.width < 2 || r.height < 2) continue;
                // Prefer Allow over Authorize
                const score = /^allow/i.test(t) ? 2 : 1;
                if (!best || score > best.score) best = { b, t, score };
              }
              if (best) { best.b.click(); return best.t.slice(0, 40); }
              return '';
            }"""
        )
        if js_hit and _is_oauth_allow_label(str(js_hit)):
            print(f"[{attempt}] OAuth Allow (js): {js_hit!r}", flush=True)
            return str(js_hit)
    except Exception as e:
        vlog(f"oauth allow js warn: {e}", attempt)

    try:
        info = await page.evaluate(
            """() => {
              const btns = [...document.querySelectorAll('button, [role="button"]')]
                .filter(b => { const r=b.getBoundingClientRect(); return r.width>2&&r.height>2; })
                .map(b => (b.innerText||b.value||'').trim().slice(0,40))
                .filter(Boolean).slice(0, 12);
              return { url: (location.href||'').slice(0,140), buttons: btns };
            }"""
        )
        print(
            f"[{attempt}] OAuth: no Allow button "
            f"url={(info or {}).get('url')} buttons={(info or {}).get('buttons')}",
            flush=True,
        )
    except Exception:
        pass
    return None


async def obtain_oidc_tokens(page, email_addr: str, password: str, attempt: int,
                             *, fast: bool = True, skip_login: bool = False) -> dict:
    """Grok CLI-style OIDC: local callback server + PKCE + browser login/Allow.

    Mirrors official Grok CLI / CLIProxyAPI:
      - callback on http://127.0.0.1:56121/callback (real TCP server)
      - same client_id + scopes as ~/.grok/auth.json
      - browser only drives login/Allow; code is captured by the server
      - no Turnstile on OAuth (only login/signup paths)
      - consent page: multi-locale Allow click before authorize-refresh
      - if stuck >25s without code AND not mid-consent click → refresh authorize
    """
    emit_progress(attempt, "oauth", "CLI OAuth PKCE (local callback)", email_addr)
    server_ok = await ensure_cli_oauth_server()

    verifier, challenge = generate_pkce_pair()
    state = secrets.token_urlsafe(24)
    nonce = secrets.token_hex(16)
    params = {
        "response_type": "code",
        "client_id": XAI_CLIENT_ID,
        "redirect_uri": XAI_REDIRECT_URI,
        "scope": XAI_SCOPE,
        "code_challenge": challenge,
        "code_challenge_method": "S256",
        "state": state,
        "nonce": nonce,
        # Official CLI / cliproxy both use this public client
        "plan": "generic",
        "referrer": "cli-proxy-api",
    }
    auth_url = f"{XAI_AUTHORIZE}?{urlencode(params)}"
    auth_code: dict[str, str | None] = {"code": None}

    # Register with CLI callback hub (primary capture path)
    code_fut: asyncio.Future | None = None
    if server_ok:
        code_fut = await _OAUTH_HUB.register(state)

    async def _handle_route(route):
        """CLI-style: let localhost callback reach the real server.

        Fallback: if server is down, capture code from the request and abort
        (old path). Never block authorize/auth hosts.
        """
        req_url = route.request.url
        is_cb = (
            req_url.startswith(f"http://{XAI_CALLBACK_HOST}:{XAI_CALLBACK_PORT}/")
            or req_url.startswith("http://localhost:56121/")
            or (
                "/callback" in req_url
                and ("127.0.0.1" in req_url or "localhost" in req_url)
            )
        )
        if is_cb:
            code, st = extract_oauth_callback(req_url)
            if code:
                auth_code["code"] = code
                delivered = _OAUTH_HUB.deliver(st, code)
                print(
                    f"[{attempt}] OAuth code seen on route "
                    f"state={(st or '')[:12]} delivered={delivered}",
                    flush=True,
                )
            if server_ok:
                # Real CLI path: browser completes redirect to our HTTP server
                try:
                    await route.continue_()
                except Exception:
                    pass
            else:
                try:
                    await route.abort()
                except Exception:
                    pass
            return
        try:
            rtype = route.request.resource_type
        except Exception:
            rtype = ""
        # Light resource filter only — do not abort documents/scripts (breaks OAuth)
        if rtype in ("image", "font", "media"):
            try:
                await route.abort()
            except Exception:
                pass
            return
        try:
            await route.continue_()
        except Exception:
            pass

    await page.route("**/*", _handle_route)
    try:
        await page.goto(auth_url, wait_until="domcontentloaded", timeout=45000)
    except Exception:
        await page.goto(auth_url, wait_until="commit", timeout=45000)

    OAUTH_STUCK_REFRESH_S = 25.0
    deadline = time.monotonic() + (90.0 if fast else 130.0)
    last_progress_t = time.monotonic()
    last_refresh_t = 0.0
    refresh_count = 0
    consent_attempts = 0

    def _code_ready() -> str | None:
        if auth_code.get("code"):
            return auth_code["code"]
        if code_fut is not None and code_fut.done() and not code_fut.cancelled():
            try:
                c = code_fut.result()
                if c:
                    auth_code["code"] = c
                    return c
            except Exception:
                pass
        return None

    async def _goto_authorize(*, reason: str) -> None:
        nonlocal last_progress_t, last_refresh_t, refresh_count
        vlog(f"oauth refresh authorize ({reason})", attempt)
        emit_progress(
            attempt, "oauth",
            f"CLI refresh authorize ({reason})",
            email_addr,
        )
        try:
            await page.goto(auth_url, wait_until="domcontentloaded", timeout=30000)
        except Exception:
            try:
                await page.goto(auth_url, wait_until="commit", timeout=30000)
            except Exception:
                pass
        last_refresh_t = time.monotonic()
        last_progress_t = last_refresh_t
        refresh_count += 1
        await asyncio.sleep(0.4)

    while time.monotonic() < deadline and not _code_ready():
        # Poll URL + server future
        for _ in range(6):
            if _code_ready():
                break
            try:
                cur = page.url or ""
            except Exception:
                cur = ""
            code = extract_code_from_url(cur)
            if code:
                auth_code["code"] = code
                break
            # Also poll any popup/tab the consent redirect may have opened
            try:
                for p in page.context.pages:
                    c2 = extract_code_from_url(p.url or "")
                    if c2:
                        auth_code["code"] = c2
                        break
            except Exception:
                pass
            if _code_ready():
                break
            await asyncio.sleep(0.2)
        if _code_ready():
            break

        await recover_page_load_error(page, attempt)

        try:
            cur = page.url or ""
        except Exception:
            cur = ""

        # Strict: only real consent URL — never treat sign-in as consent
        # (bug: loose match + last-button JS clicked "Sign out" / "Login with email")
        on_consent = "/oauth2/consent" in cur
        on_signin = "/sign-in" in cur or "/login" in cur
        on_xai = "accounts.x.ai" in cur or "auth.x.ai" in cur

        stuck_for = time.monotonic() - last_progress_t
        since_refresh = time.monotonic() - last_refresh_t

        # ── Consent: Allow only (refer-style), never Sign out ───────────
        if on_consent:
            emit_progress(
                attempt, "oauth",
                f"consent Allow try {consent_attempts + 1}…",
                email_addr,
            )
            clicked_allow = await click_oauth_consent_allow(page, attempt)
            consent_attempts += 1
            if clicked_allow:
                last_progress_t = time.monotonic()
                emit_progress(
                    attempt, "oauth",
                    f"Clicked {clicked_allow} → CLI callback",
                    email_addr,
                )
                spin_deadline = time.monotonic() + 18.0
                while time.monotonic() < spin_deadline:
                    if _code_ready():
                        break
                    try:
                        for p in page.context.pages:
                            c2 = extract_code_from_url(p.url or "")
                            if c2:
                                auth_code["code"] = c2
                                break
                    except Exception:
                        pass
                    await asyncio.sleep(0.12)
                if _code_ready():
                    break
                if consent_attempts >= 2 and time.monotonic() - last_refresh_t > 12:
                    await _goto_authorize(reason="Allow clicked, no callback yet")
                continue
            if consent_attempts >= 3 and time.monotonic() - last_refresh_t >= 15:
                await _goto_authorize(reason=f"consent no Allow x{consent_attempts}")
            await asyncio.sleep(0.5)
            continue

        if (
            stuck_for >= OAUTH_STUCK_REFRESH_S
            and since_refresh >= OAUTH_STUCK_REFRESH_S
            and not on_consent
        ):
            await _goto_authorize(reason=f"stuck {stuck_for:.0f}s no code")
            continue

        if cur.rstrip("/").endswith("accounts.x.ai/account") or cur.rstrip("/") == "https://accounts.x.ai/account":
            await _goto_authorize(reason="on /account, force redirect")
            continue

        # ── Sign-in / authorize (refer loop shape) ──────────────────────
        if (not skip_login) and on_xai and (on_signin or not on_consent):
            await dismiss_cookie_banner(page)
            if await page.locator('input[type="email"], input[type="password"]').count() == 0:
                await click_login_with_email(page)
                await asyncio.sleep(0.5)
            has_form = await page.locator('input[type="email"], input[type="password"]').count() > 0
            has_email_btn = await page.locator(
                "text=/Login with email|Log in with email|Sign in with email|"
                "使用邮箱登录|Masuk dengan|メールでログイン/i"
            ).count() > 0
            if has_form or has_email_btn:
                emit_progress(attempt, "oauth", "CLI OAuth needs login", email_addr)
                await drive_email_password_login(
                    page, email_addr, password, attempt,
                    rounds=2 if fast else 5,
                    ts_max_wait=12.0 if fast else 22.0,
                    post_click_sleep=1.2 if fast else 2.5,
                    use_global_limit=False,
                )
                last_progress_t = time.monotonic()
                await _goto_authorize(reason="post-login")
                continue

        # On authorize/consent-ish xAI pages: try Allow only if labels match
        if on_xai and not on_signin:
            await dismiss_cookie_banner(page)
            clicked_allow = await click_oauth_consent_allow(page, attempt)
            if clicked_allow:
                last_progress_t = time.monotonic()
                emit_progress(attempt, "oauth", f"Clicked {clicked_allow} → CLI callback", email_addr)
                spin_deadline = time.monotonic() + 15.0
                while time.monotonic() < spin_deadline:
                    if _code_ready():
                        break
                    await asyncio.sleep(0.12)
                if _code_ready():
                    break
                await _goto_authorize(reason="Allow clicked, no callback yet")
                continue
            if await page.locator(
                'input[name="code"], input[autocomplete="one-time-code"]'
            ).count() > 0:
                otp = await asyncio.get_event_loop().run_in_executor(
                    None, lambda: read_otp_from_imap_sync(email_addr, 90)
                )
                if otp:
                    chars = re.sub(r"[^A-Z0-9]", "", otp.upper())
                    await fill_xai_otp_boxes(page, chars, attempt)
                    await click_text_button(page, ["Confirm", "Verify", "Continue", "Submit"])
                    last_progress_t = time.monotonic()

        await asyncio.sleep(0.4)

    # Backup: other pages / unfinished future
    if not _code_ready():
        try:
            for p in page.context.pages:
                c = extract_code_from_url(p.url or "")
                if c:
                    auth_code["code"] = c
                    break
        except Exception:
            pass

    try:
        await page.unroute("**/*")
    except Exception:
        pass
    try:
        await _OAUTH_HUB.unregister(state)
    except Exception:
        pass

    code = _code_ready()
    if not code:
        await screenshot(page, attempt, "oauth_no_code")
        try:
            cur = (page.url or "")[:160]
            hint = await page.evaluate(
                """() => {
                    const t = (document.body && document.body.innerText || '').slice(0, 200);
                    return t.replace(/\\s+/g, ' ').trim();
                }"""
            )
        except Exception:
            cur, hint = "", ""
        raise RuntimeError(
            f"CLI OAuth code not captured (timeout, refreshes={refresh_count}, "
            f"server={'up' if server_ok else 'down'}). "
            f"url={cur!r} page={hint[:120]!r}. "
            "Expected redirect to 127.0.0.1:56121/callback like official Grok CLI."
        )

    emit_progress(attempt, "token_exchange", "Exchanging code (CLI token endpoint)", email_addr)
    try:
        tokens = await _run_io(exchange_code_for_tokens, code, verifier)
    except Exception as e:
        # 400 invalid_grant under concurrent OAuth → re-run OAuth, not permanent fail
        print(f"[{attempt}] token exchange failed: {e}", flush=True)
        raise RecoverableFarmError(
            f"token exchange failed: {e}",
            delay_s=2.0,
            tag="TokenExchange400",
        ) from e
    if not tokens.get("email"):
        tokens["email"] = email_addr
    tokens["auth_mode"] = "oidc"
    tokens["cli_style"] = True
    return tokens


# ── Worker ───────────────────────────────────────────────────────────────────
async def activate_grok_com(
    page, email_addr: str, password: str, attempt: int,
) -> bool:
    """Visit grok.com, solve CF, login if needed (port from refer/grok-farm-refer).

    Many free CLI 403s happen when OAuth tokens exist but the account never
    opened the web product. First real session on grok.com often attaches
    free Build / chat entitlement. Not guaranteed — still server-side gated.
    """
    emit_progress(attempt, "activate", "Activating on grok.com (web + CF)", email_addr)

    async def _cf_managed_challenge_visible() -> bool:
        try:
            title = (await page.title() or "").lower()
            body = ""
            try:
                body = (await page.inner_text("body"))[:1200].lower()
            except Exception:
                body = ""
            needles = (
                "verify you are human",
                "performing security verification",
                "checking your browser",
                "just a moment",
                "hanya sebentar",
                "enable javascript and cookies",
                "security service to protect against malicious bots",
            )
            if any(n in title or n in body for n in needles):
                return True
            if await page.locator(
                "text=Verify you are human, "
                "iframe[src*='challenges.cloudflare'], "
                "iframe[src*='turnstile'], "
                "[data-sitekey]"
            ).count() > 0:
                return True
            return False
        except Exception:
            return False

    async def _page_ready() -> bool:
        try:
            title = (await page.title() or "").lower()
            body = ""
            try:
                body = (await page.inner_text("body"))[:1200].lower()
            except Exception:
                body = ""
            just_a_moment = any(
                n in title or n in body
                for n in (
                    "just a moment",
                    "hanya sebentar",
                    "checking your browser",
                    "enable javascript and cookies",
                    "verify you are human",
                    "performing security verification",
                )
            )
            has_ui = (
                await page.locator(
                    'textarea, '
                    '[contenteditable="true"], '
                    'input[placeholder*="Ask" i], '
                    'button:has-text("Sign in"), '
                    'button:has-text("Log in"), '
                    '[data-testid], '
                    'nav, '
                    'main'
                ).count()
                > 0
            )
            url_ok = "grok.com" in (page.url or "")
            return bool(
                url_ok
                and not just_a_moment
                and (has_ui or ("grok" in body and "cloudflare" not in body))
            )
        except Exception:
            return False

    async def _goto_grok() -> None:
        try:
            await page.goto("https://grok.com/", wait_until="domcontentloaded", timeout=60000)
        except Exception:
            try:
                await page.goto("https://grok.com/", wait_until="commit", timeout=60000)
            except Exception:
                pass

    async def _solve_cf_if_needed(round_label: str, *, max_wait: float = 25.0) -> bool:
        """Shorter CF wait — concurrent c>3 must not sit 60s×3 on activate."""
        if await _page_ready():
            return True
        emit_progress(
            attempt, "activate",
            f"grok.com CF ({round_label})…",
            email_addr,
        )
        if await _cf_managed_challenge_visible():
            print(f"[{attempt}] activate CF challenge ({round_label})", flush=True)
            try:
                await try_click_turnstile(page, attempt)
            except Exception as e:
                print(f"[{attempt}] activate CF click warn: {e}", flush=True)
            try:
                ok = await handle_turnstile(
                    page,
                    attempt,
                    max_wait=min(22.0, max_wait),
                    require_token=False,
                    use_global_limit=False,
                    allow_remount=True,
                )
                print(
                    f"[{attempt}] activate CF handle_turnstile={ok} ({round_label})",
                    flush=True,
                )
            except Exception as e:
                print(f"[{attempt}] activate CF handle warn: {e}", flush=True)
            await asyncio.sleep(1.0)
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=10000)
            except Exception:
                pass
        deadline = time.monotonic() + max_wait
        tick = 0
        while time.monotonic() < deadline:
            if await _page_ready():
                return True
            tick += 1
            if tick % 8 == 0:
                emit_progress(
                    attempt, "activate",
                    f"waiting grok.com ({round_label}) {int(deadline - time.monotonic())}s…",
                    email_addr,
                )
            if await _cf_managed_challenge_visible():
                try:
                    await try_click_turnstile(page, attempt)
                except Exception:
                    pass
            await asyncio.sleep(0.5)
        return await _page_ready()

    # Wall clock for whole activate (avoid multi-minute hang under concurrent load)
    activate_deadline = time.monotonic() + 90.0

    await _goto_grok()
    ready = await _solve_cf_if_needed("r1", max_wait=22.0)
    if not ready and time.monotonic() < activate_deadline:
        print(f"[{attempt}] activate: reload grok.com", flush=True)
        emit_progress(attempt, "activate", "reload grok.com…", email_addr)
        try:
            await page.reload(wait_until="domcontentloaded", timeout=45000)
        except Exception:
            await _goto_grok()
        await asyncio.sleep(0.8)
        ready = await _solve_cf_if_needed("r2", max_wait=18.0)
    if not ready and time.monotonic() < activate_deadline:
        print(f"[{attempt}] activate: cool-down + retry", flush=True)
        emit_progress(attempt, "activate", "activate cool-down…", email_addr)
        await asyncio.sleep(2.0)
        await _goto_grok()
        ready = await _solve_cf_if_needed("r3", max_wait=15.0)
    if not ready:
        print(f"[{attempt}] grok.com not ready after CF retries", flush=True)
        await screenshot(page, attempt, "grok_com_not_ready")
        return False

    print(f"[{attempt}] grok.com ready", flush=True)
    emit_progress(attempt, "activate", "grok.com ready", email_addr)
    await dismiss_cookie_banner(page)

    needs_login = True
    try:
        has_chat = await page.locator('textarea, [contenteditable="true"]').count() > 0
        has_signin = await page.locator("text=/[Ss]ign in|[Ll]og in/").count() > 0
        if has_chat and not has_signin:
            needs_login = False
            print(f"[{attempt}] already logged in on grok.com", flush=True)
    except Exception:
        pass

    if needs_login:
        try:
            await click_text_button(
                page,
                ["Sign in", "Log in", "Login", "Get started"],
                exclude=["Google", "Apple", "Continue with"],
            )
            await asyncio.sleep(1.5)
        except Exception:
            pass
        cur = page.url or ""
        if "accounts.x.ai" in cur or "auth.x.ai" in cur:
            await dismiss_cookie_banner(page)
            if await page.locator('input[type="email"], input[type="password"]').count() == 0:
                await click_login_with_email(page)
                await asyncio.sleep(0.8)
            has_form = (
                await page.locator('input[type="email"], input[type="password"]').count() > 0
            )
            if has_form:
                await drive_email_password_login(
                    page, email_addr, password, attempt,
                    rounds=2, ts_max_wait=12.0, post_click_sleep=1.2,
                    use_global_limit=False,
                )
            await handle_turnstile(
                page, attempt, max_wait=15, use_global_limit=False,
            )
            # OAuth consent if any — Allow only (never Deny)
            if "/oauth2/consent" in (page.url or ""):
                await click_oauth_consent_allow(page, attempt)
            await asyncio.sleep(1.2)
            try:
                await page.wait_for_url("**/grok.com/**", timeout=15000)
            except Exception:
                pass
            await asyncio.sleep(1.0)
            if not await _page_ready():
                await _solve_cf_if_needed("post-login", max_wait=12.0)

    try:
        # Onboarding only — never cookie Reject / OAuth Deny
        await click_text_button(
            page,
            ["Got it", "Start", "OK", "I agree"],
            exclude=["Deny", "Cancel", "Decline", "No thanks", "Reject", "Sign out"],
        )
    except Exception:
        pass

    final_url = page.url or ""
    await screenshot(page, attempt, "grok_com_activated")
    print(f"[{attempt}] grok.com activation done, url={final_url[:80]}", flush=True)
    if "accounts.x.ai" in final_url or "auth.x.ai" in final_url:
        print(f"[{attempt}] activate hard-fail: still on auth page", flush=True)
        return False
    if "grok.com" not in final_url:
        print(f"[{attempt}] activate hard-fail: unexpected url", flush=True)
        return False
    try:
        has_chat = await page.locator('textarea, [contenteditable="true"]').count() > 0
        has_signin = await page.locator("text=/[Ss]ign in|[Ll]og in/").count() > 0
        if has_signin and not has_chat:
            print(f"[{attempt}] activate hard-fail: still showing sign-in", flush=True)
            return False
        if await _cf_managed_challenge_visible() and not has_chat:
            print(f"[{attempt}] activate hard-fail: still on CF challenge", flush=True)
            return False
    except Exception:
        pass
    return True


async def _do_register_body(attempt_num: int, email_addr: str, password: str, proxy_url: str, proxy_id: str, mail_page=None) -> dict:
    """Core farm path — may raise. Caller applies account-level timeout.

    Isolation + speed (same contract as refresh after signup):
      - Own Camoufox + optional proxy (never shared)
      - Turnstile solved in-process (no cross-worker semaphore)
      - Post-signup: login → oauth → activate grok.com → dual CLI probe
    Signup/OTP stay patient — only the login→token tail is speed-matched to refresh.
    """
    emit_progress(attempt_num, "browser", "Launching Camoufox", email_addr)
    manager = None
    try:
        manager, browser, page = await launch_browser(
            proxy_url,
            purpose="signup",
            worker_id=attempt_num,
            email=email_addr,
        )
        _frame_set_email(manager, email_addr)
        _plog = "direct"
        if proxy_url:
            try:
                _u = urlparse(proxy_url if "://" in proxy_url else f"http://{proxy_url}")
                _plog = f"{_u.scheme}://{_u.hostname}:{_u.port or ''}"
                if _u.username:
                    _plog = f"{_u.scheme}://{_u.username}:***@{_u.hostname}:{_u.port or ''}"
            except Exception:
                _plog = (proxy_url[:32] + "…") if len(proxy_url) > 32 else proxy_url
        print(
            f"[{attempt_num}] Browser up: {email_addr} proxy={_plog} id={proxy_id or '-'}",
            flush=True,
        )
        await do_signup(page, email_addr, password, attempt_num, mail_page)

        # Post-signup tail — same speed/isolation as refresh:
        #   login (fast, independent) → oauth (skip re-login when ok)
        login_ok = False
        try:
            login_ok = await do_email_login(
                page, email_addr, password, attempt_num, fast=True
            )
        except Exception as e:
            print(f"[{attempt_num}] login branch warn: {e}", flush=True)
            login_ok = False
        if not login_ok:
            print(
                f"[{attempt_num}] login not confirmed for {email_addr} — "
                f"OAuth will re-drive login (independent path)",
                flush=True,
            )

        tokens = await obtain_oidc_tokens(
            page,
            email_addr,
            password,
            attempt_num,
            fast=True,
            skip_login=bool(login_ok),
        )
        access = str(tokens.get("access_token") or "")
        if not access:
            raise RuntimeError("OAuth succeeded but access_token missing")

        # Refer path: first web session on grok.com unlocks free CLI chat.
        activated = False
        if ACTIVATE_WEB:
            try:
                activated = await activate_grok_com(
                    page, email_addr, password, attempt_num,
                )
            except Exception as _ae:
                print(f"[{attempt_num}] activate_grok_com error: {_ae}", flush=True)
                activated = False
            tokens["web_activated"] = bool(activated)
            if not activated:
                raise RecoverableFarmError(
                    "activate_grok_com failed (CF/login/UI) — will retry fresh browser",
                    delay_s=2.5,
                    tag="ActivateFail",
                )
        else:
            tokens["web_activated"] = None  # skipped by config

        # Gate: grok-4.5 Responses. Soft-retry probe (and re-activate once) on 403
        # before giving up — concurrent farms often hit brief entitlement lag.
        ok, status, detail, credits = False, 0, "", {}
        for probe_i in range(1, PROBE_RETRIES + 1):
            ok, status, detail, credits = await run_chat_probe_with_hud(
                attempt_num, email_addr, access, context="farm",
            )
            if ok:
                break
            is_403 = status == 403 or "permission-denied" in (detail or "").lower()
            if not is_403:
                break
            if probe_i >= PROBE_RETRIES:
                break
            print(
                f"[{attempt_num}] chat 403 soft-retry {probe_i}/{PROBE_RETRIES} "
                f"(wait entitlement; re-activate only once) "
                f"after {PROBE_RETRY_BACKOFF_S * probe_i:.1f}s",
                flush=True,
            )
            emit_progress(
                attempt_num,
                "chat_probe",
                f"403 soft-retry {probe_i}/{PROBE_RETRIES}…",
                email_addr,
            )
            await asyncio.sleep(PROBE_RETRY_BACKOFF_S * probe_i)
            # Full re-activate is slow under concurrent load — only once
            if ACTIVATE_WEB and probe_i == 1:
                try:
                    emit_progress(
                        attempt_num, "activate",
                        "403 re-activate once…",
                        email_addr,
                    )
                    await activate_grok_com(page, email_addr, password, attempt_num)
                except Exception as _ae:
                    print(f"[{attempt_num}] re-activate warn: {_ae}", flush=True)

        if not ok:
            domain = email_domain(email_addr)
            # 403 permission-denied on free CLI chat:
            #   tempmail → blacklist domain + re-roll (DomainRejectedError)
            #   google   → NEVER blacklist; RecoverableFarmError so outer loop
            #              can try a NEW local-part after cool-down (not permanent
            #              fail on first IP/rate-limit blip).
            if status == 403 or "permission-denied" in (detail or "").lower():
                if MAIL_MODE == "tempmail":
                    print(
                        f"[{attempt_num}] chat 403 → tempmail domain @{domain} "
                        f"denied — EXIT browsers, re-roll NEW domain "
                        f"(web_activated={activated})",
                        flush=True,
                    )
                    raise DomainRejectedError(
                        domain or "unknown",
                        f"chat probe denied ({detail}) email={email_addr}",
                    )
                print(
                    f"[{attempt_num}] chat 403 on google @{domain} after "
                    f"{PROBE_RETRIES} probe tries — will retry NEW email "
                    f"(domain NOT blacklisted) web_activated={activated}",
                    flush=True,
                )
                raise RecoverableFarmError(
                    f"chat probe 403 @{domain} after soft-retries "
                    f"(web_activated={activated}): {detail}",
                    delay_s=3.0,
                    tag="Chat403",
                )
            raise RecoverableFarmError(
                f"chat probe failed: {detail}",
                delay_s=2.0,
                tag="ChatProbeFail",
            )
        rem = credits.get("credits_remaining")
        lim = credits.get("credits_limit")
        tokens["chat_ok"] = True
        tokens["chat_probe"] = detail
        tokens["credits_remaining"] = rem
        tokens["credits_limit"] = lim
        tokens["probe_model"] = credits.get("model") or CLI_PROBE_MODEL
        # HUD batch totals + per-account success line
        HUD.record_credits(rem, lim)
        # Leave "probe" stage before slow browser teardown (HUD looked stuck 200+s)
        emit_progress(
            attempt_num,
            "cleanup",
            "probe OK — closing browsers…",
            email_addr,
        )
        return {
            "email": email_addr,
            "password": password,
            "created_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "attempt": attempt_num,
            "proxy": proxy_url or "direct",
            "tokens": tokens,
            "verified": True,
            "verify_status": int(status or 200),
            "verify_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "verify_credits_remaining": rem,
            "verify_credits_limit": lim,
            "web_activated": tokens.get("web_activated"),
        }
    finally:
        # ALWAYS kill this attempt's browsers — success or 403 re-roll.
        # Re-roll must not inherit cookies/profile from a denied account.
        # Windows tree-kill can take tens of seconds — not a hang on probe.
        if manager is not None or mail_page is not None:
            try:
                emit_progress(
                    attempt_num,
                    "cleanup",
                    "closing browsers (Windows cleanup can take a while)…",
                    email_addr or "",
                )
            except Exception:
                pass
        if manager is not None:
            print(
                f"[{attempt_num}] closing signup browser (fresh spawn on next try)",
                flush=True,
            )
            await close_browser(manager)
            manager = None
        if mail_page is not None:
            print(
                f"[{attempt_num}] closing temp-mail browser (fresh spawn on next try)",
                flush=True,
            )
            await tempmail_close(attempt_num)
            mail_page = None


async def _do_register(attempt_num: int) -> dict | None:
    """Register one account with self-heal retries.

    Recoverable UI errors (no email input, OTP stuck, activate fail, chat 403
    soft-retries exhausted on google): NEW browser + NEW email, up to UI_RETRIES.

    tempmail DomainRejectedError: blacklist domain + re-roll (MAX_DOMAIN_RETRIES).
    google: NEVER blacklist the fixed catch-all domain.
    """
    MAX_DOMAIN_RETRIES = 8 if MAIL_MODE == "tempmail" else max(1, UI_RETRIES)
    # Outer = domain re-rolls (tempmail) or UI/403 re-rolls (google).
    # Inner UI_RETRIES stacks only for pure UI flukes on the same domain try.

    mail_page = None
    email_addr = ""
    password = ACCOUNT_PASSWORD
    last_err_msg = ""

    for domain_attempt in range(1, MAX_DOMAIN_RETRIES + 1):
        # Always start clean: no leftover page refs from a previous try.
        mail_page = None
        # Fresh proxy every attempt (including first) so re-rolls don't stick
        # to the same exit IP as the 403'd account.
        proxy_url, proxy_id = await next_proxy()
        _attempt_proxy[attempt_num] = proxy_id

        if domain_attempt > 1:
            emit_progress(
                attempt_num,
                "ui_retry" if MAIL_MODE == "google" else "domain_rejected",
                f"spawn NEW browsers (try {domain_attempt}/{MAX_DOMAIN_RETRIES})",
                email_addr or "",
            )
            print(
                f"[{attempt_num}] re-try #{domain_attempt}/{MAX_DOMAIN_RETRIES}: "
                f"NEW signup browser + NEW email/temp-mail + NEW proxy"
                + (f" after: {last_err_msg[:100]}" if last_err_msg else ""),
                flush=True,
            )

        if MAIL_MODE == "tempmail":
            emit_progress(
                attempt_num, "tempmail_launch",
                f"Launching NEW temp-mail browser (try {domain_attempt})",
                "",
            )
            try:
                # preview=False: temp-mail browser is internal; do not stream frames
                _mmgr, _mbrowser, mail_page = await launch_browser(
                    None,
                    headless=TEMPMAIL_HEADLESS,
                    block_images=TEMPMAIL_BLOCK_IMAGES,
                    purpose="tempmail",
                    preview=False,
                )
                # Strict isolation: this attempt's mail browser only
                _tempmail_sessions[attempt_num] = {
                    "page": mail_page,
                    "browser": _mbrowser,
                    "manager": _mmgr,
                    "email": "",
                    "inbox_urls": [],
                    "worker": attempt_num,
                }
                email_addr = await tempmail_gen_email(mail_page, attempt_num)
            except Exception as e:
                if mail_page is not None or attempt_num in _tempmail_sessions:
                    await tempmail_close(attempt_num)
                mail_page = None
                if _is_recoverable_error(e) and domain_attempt < MAX_DOMAIN_RETRIES:
                    last_err_msg = str(e)
                    await asyncio.sleep(UI_RETRY_BACKOFF_S * domain_attempt)
                    continue
                raise
        else:
            email_addr = await generate_email()

        emit_progress(
            attempt_num, "start",
            f"Starting Grok farm #{attempt_num} "
            f"(try {domain_attempt}/{MAX_DOMAIN_RETRIES})",
            email_addr,
        )
        try:
            # _do_register_body always launch_browser() for signup, then
            # finally: close_browser(manager) + tempmail_close — so on 403
            # both browsers are dead before we continue the loop.
            result = await asyncio.wait_for(
                _do_register_body(
                    attempt_num, email_addr, password, proxy_url, proxy_id, mail_page
                ),
                timeout=ACCOUNT_TIMEOUT_S,
            )
            await save_result_to_file(result)
            rem = result.get("verify_credits_remaining")
            lim = result.get("verify_credits_limit")
            cred_msg = ""
            if rem is not None or lim is not None:
                cred_msg = (
                    f" · credits {FarmHUD.fmt_credits(rem)}/"
                    f"{FarmHUD.fmt_credits(lim)}"
                )
            emit_success(
                attempt_num,
                email_addr,
                f"Account farmed + CLI OK{cred_msg}",
            )
            return result
        except DomainRejectedError as dre:
            # TEMPMAIL ONLY path for blacklist + re-roll.
            # Google mode must never raise this for chat 403 (see _do_register_body);
            # if signup still raises it, fail without blacklisting the fixed domain.
            if MAIL_MODE != "tempmail":
                # Treat as recoverable on google (new local-part) rather than
                # permanent fail — domain is never blacklisted.
                last_err_msg = str(dre)
                if mail_page is not None:
                    await tempmail_close(attempt_num)
                mail_page = None
                if domain_attempt < MAX_DOMAIN_RETRIES:
                    emit_progress(
                        attempt_num,
                        "ui_retry",
                        f"google domain issue — retry {domain_attempt}/{MAX_DOMAIN_RETRIES}",
                        email_addr,
                    )
                    await asyncio.sleep(UI_RETRY_BACKOFF_S * domain_attempt)
                    continue
                msg = (
                    f"domain/chat issue on google mode @{dre.domain} "
                    f"(domain NOT blacklisted) after {MAX_DOMAIN_RETRIES} tries: {dre}"
                )
                print(f"[{attempt_num}] FAILED: {msg}", flush=True)
                emit_failed(attempt_num, msg, "ChatOrDomainFail")
                try:
                    await save_failed_to_file(attempt_num, email_addr, msg)
                except Exception:
                    pass
                return None

            # tempmail: blacklist + re-roll
            if dre.domain and dre.domain != "unknown":
                blacklist_add(dre.domain)
            emit_progress(
                attempt_num,
                "domain_rejected",
                f"closing browsers after deny @{dre.domain}…",
                email_addr,
            )
            if mail_page is not None:
                await tempmail_close(attempt_num)
            mail_page = None  # must not reuse closed page
            last_err_msg = str(dre)
            if domain_attempt >= MAX_DOMAIN_RETRIES:
                msg = (
                    f"domain rejected/chat-denied {MAX_DOMAIN_RETRIES}x "
                    f"(last={dre.domain}); giving up on #{attempt_num}"
                )
                print(f"[{attempt_num}] FAILED: {msg}", flush=True)
                emit_failed(attempt_num, msg, "DomainRejected")
                await save_failed_to_file(attempt_num, email_addr, msg)
                return None
            print(
                f"[{attempt_num}] tempmail domain {dre.domain!r} rejected/chat-denied "
                f"-> blacklisted; EXIT browsers, spawn NEW on next try "
                f"({domain_attempt}/{MAX_DOMAIN_RETRIES}) ({dre})",
                flush=True,
            )
            emit_progress(
                attempt_num,
                "domain_rejected",
                f"@{dre.domain} denied — next try = NEW browsers",
                email_addr,
            )
            continue  # loop: NEW proxy + NEW temp-mail + NEW signup browser
        except asyncio.TimeoutError:
            last_err_msg = f"account timeout after {ACCOUNT_TIMEOUT_S}s"
            if mail_page is not None:
                await tempmail_close(attempt_num)
            mail_page = None
            if domain_attempt < MAX_DOMAIN_RETRIES:
                print(
                    f"[{attempt_num}] TIMEOUT — self-heal retry "
                    f"{domain_attempt}/{MAX_DOMAIN_RETRIES} (fresh browser)",
                    flush=True,
                )
                emit_progress(
                    attempt_num,
                    "ui_retry",
                    f"timeout → retry {domain_attempt + 1}/{MAX_DOMAIN_RETRIES}",
                    email_addr,
                )
                await asyncio.sleep(UI_RETRY_BACKOFF_S * domain_attempt)
                continue
            print(f"[{attempt_num}] FAILED: {last_err_msg}", flush=True)
            emit_failed(attempt_num, last_err_msg, "AccountTimeout")
            try:
                await save_failed_to_file(attempt_num, email_addr, last_err_msg)
            except Exception:
                pass
            return None
        except RecoverableFarmError as re_err:
            last_err_msg = str(re_err)
            tag = getattr(re_err, "tag", "Recoverable") or "Recoverable"
            delay = float(getattr(re_err, "delay_s", UI_RETRY_BACKOFF_S) or UI_RETRY_BACKOFF_S)
            if mail_page is not None:
                await tempmail_close(attempt_num)
            mail_page = None
            if domain_attempt < MAX_DOMAIN_RETRIES:
                print(
                    f"[{attempt_num}] self-heal [{tag}] try {domain_attempt}/"
                    f"{MAX_DOMAIN_RETRIES}: {last_err_msg[:140]} "
                    f"→ cool-down {delay * domain_attempt:.1f}s + NEW browser",
                    flush=True,
                )
                emit_progress(
                    attempt_num,
                    "ui_retry",
                    f"[{tag}] retry {domain_attempt + 1}/{MAX_DOMAIN_RETRIES}",
                    email_addr,
                )
                await asyncio.sleep(delay * domain_attempt)
                continue
            print(
                f"[{attempt_num}] FAILED after {MAX_DOMAIN_RETRIES} self-heal tries "
                f"[{tag}]: {last_err_msg[:200]}",
                flush=True,
            )
            emit_failed(attempt_num, last_err_msg[:200], tag)
            try:
                await save_failed_to_file(attempt_num, email_addr, last_err_msg[:400])
            except Exception:
                pass
            return None
        except Exception as e:
            last_err_msg = str(e)
            if mail_page is not None:
                await tempmail_close(attempt_num)
            mail_page = None
            if _is_recoverable_error(e) and domain_attempt < MAX_DOMAIN_RETRIES:
                print(
                    f"[{attempt_num}] self-heal [{type(e).__name__}] try "
                    f"{domain_attempt}/{MAX_DOMAIN_RETRIES}: {last_err_msg[:140]} "
                    f"→ NEW browser",
                    flush=True,
                )
                emit_progress(
                    attempt_num,
                    "ui_retry",
                    f"[{type(e).__name__}] retry {domain_attempt + 1}/{MAX_DOMAIN_RETRIES}",
                    email_addr,
                )
                await asyncio.sleep(UI_RETRY_BACKOFF_S * domain_attempt)
                continue
            print(f"[{attempt_num}] FAILED: {e}", flush=True)
            emit_failed(attempt_num, str(e)[:200], type(e).__name__)
            try:
                await save_failed_to_file(attempt_num, email_addr, str(e)[:400])
            except Exception:
                pass
            return None

    return None


async def register_one_account(attempt_num: int, semaphore: asyncio.Semaphore) -> dict | None:
    async with semaphore:
        return await _do_register(attempt_num)


# ── Non-blocking result writes (keep HUD smooth under concurrency) ──────────
# Problem: c=5 workers doing read-JSON → rewrite-JSON on the asyncio event loop
# freezes the HUD ticker. Fix:
#   1) keep accounts/failed lists in memory (no re-read each save)
#   2) all disk I/O under a threading.Lock in a worker thread (asyncio.to_thread)
#   3) append-only for .txt token lines (cheap)
#   4) optional write queue so callers can fire-and-forget without awaiting disk
_results_thread_lock = threading.Lock()
_results_lock = asyncio.Lock()  # kept for rare async sections that still need it
_accounts_mem: list[dict] = []
_failed_mem: list[dict] = []
_results_mem_ready = False
_write_q: asyncio.Queue | None = None
_write_worker_task: asyncio.Task | None = None


def _reset_results_memory(accounts: list | None = None, failed: list | None = None) -> None:
    """Call from init_batch / refresh truncate so we start clean."""
    global _accounts_mem, _failed_mem, _results_mem_ready
    with _results_thread_lock:
        _accounts_mem = list(accounts) if accounts is not None else []
        _failed_mem = list(failed) if failed is not None else []
        _results_mem_ready = True


def _load_results_memory_unlocked() -> None:
    """Load JSON caches once if not already seeded (legacy / unexpected paths)."""
    global _accounts_mem, _failed_mem, _results_mem_ready
    if _results_mem_ready:
        return
    _accounts_mem = []
    if RESULTS_JSON.is_file():
        try:
            data = json.loads(RESULTS_JSON.read_text(encoding="utf-8"))
            if isinstance(data, list):
                _accounts_mem = data
        except Exception:
            _accounts_mem = []
    _failed_mem = []
    if FAILED_JSON.is_file():
        try:
            data = json.loads(FAILED_JSON.read_text(encoding="utf-8"))
            if isinstance(data, list):
                _failed_mem = data
        except Exception:
            _failed_mem = []
    _results_mem_ready = True


def _append_line_sync(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "a", encoding="utf-8") as f:
        f.write(line if line.endswith("\n") else line + "\n")


def _write_json_atomic(path: Path, data: list) -> None:
    """Write JSON via temp file + replace so readers never see half-written files."""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    payload = json.dumps(data, indent=2) + "\n"
    tmp.write_text(payload, encoding="utf-8")
    tmp.replace(path)


def _save_result_sync(result: dict) -> None:
    """Blocking disk write — always run via asyncio.to_thread / write worker."""
    global _accounts_mem
    with _results_thread_lock:
        _load_results_memory_unlocked()
        _accounts_mem.append(result)
        _write_json_atomic(RESULTS_JSON, _accounts_mem)

        tokens = result.get("tokens") or {}
        line = "|".join([
            str(result.get("email") or ""),
            str(result.get("password") or ""),
            str(tokens.get("access_token") or ""),
            str(tokens.get("refresh_token") or ""),
            str(tokens.get("expires_at") or ""),
        ])
        _append_line_sync(RESULTS_TXT, line)
        access_token = tokens.get("access_token")
        if access_token:
            _append_line_sync(ACCESS_TOKEN_FILE, str(access_token))
        refresh_token = tokens.get("refresh_token")
        if refresh_token:
            _append_line_sync(REFRESH_TOKEN_FILE, str(refresh_token))
        email = (result.get("email") or "").lower()
        if email:
            # generate_email already reserved used_emails.txt; keep set in sync only
            _used_emails.add(email)


def _save_failed_sync(attempt: int, email: str, error: str) -> None:
    global _failed_mem
    with _results_thread_lock:
        _load_results_memory_unlocked()
        _failed_mem.append({
            "attempt": attempt,
            "email": email,
            "error": error,
            "at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        })
        _write_json_atomic(FAILED_JSON, _failed_mem)


def _save_refresh_success_sync(acct: dict, tokens: dict) -> None:
    """Refresh-mode success: append AT/RT lines + batch accounts.json record."""
    global _accounts_mem
    with _results_thread_lock:
        _load_results_memory_unlocked()
        at = tokens.get("access_token")
        rt = tokens.get("refresh_token")
        if at:
            _append_line_sync(ACCESS_TOKEN_FILE, str(at))
        if rt:
            _append_line_sync(REFRESH_TOKEN_FILE, str(rt))
        _accounts_mem.append({
            "email": acct["email"],
            "password": acct["password"],
            "reauth_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "tokens": tokens,
        })
        _write_json_atomic(RESULTS_JSON, _accounts_mem)


async def _ensure_write_worker() -> None:
    """Start background write worker once (serializes disk, never blocks HUD)."""
    global _write_q, _write_worker_task
    if _write_q is not None and _write_worker_task is not None and not _write_worker_task.done():
        return
    _write_q = asyncio.Queue()

    async def _worker() -> None:
        assert _write_q is not None
        while True:
            job = await _write_q.get()
            try:
                if job is None:
                    return
                kind = job[0]
                if kind == "result":
                    await _run_io(_save_result_sync, job[1])
                elif kind == "failed":
                    await _run_io(_save_failed_sync, job[1], job[2], job[3])
                elif kind == "refresh":
                    await _run_io(_save_refresh_success_sync, job[1], job[2])
                elif kind == "fn":
                    await _run_io(job[1], *job[2])
            except Exception as e:
                print(f"[write] background save error: {e}", flush=True)
            finally:
                _write_q.task_done()

    _write_worker_task = asyncio.create_task(_worker())


async def flush_result_writes(timeout: float = 30.0) -> None:
    """Wait until the write queue is empty (call before process exit)."""
    global _write_q, _write_worker_task
    q = _write_q
    if q is None:
        return
    try:
        await asyncio.wait_for(q.join(), timeout=timeout)
    except asyncio.TimeoutError:
        print("[write] flush timed out — some results may still be draining", flush=True)


async def stop_result_writer() -> None:
    """Flush + stop the background writer. Safe to call multiple times."""
    global _write_q, _write_worker_task
    await _ensure_write_worker()
    q = _write_q
    task = _write_worker_task
    if q is None:
        return
    await flush_result_writes()
    await q.put(None)
    if task is not None:
        try:
            await asyncio.wait_for(task, timeout=10.0)
        except Exception:
            task.cancel()
    _write_worker_task = None
    _write_q = None


async def save_result_to_file(result: dict, *, wait: bool = False) -> None:
    """Queue a success write. Does not block the event loop / HUD.

    wait=False (default): fire-and-forget to background writer.
    wait=True: await the disk write (still off the event loop via to_thread).
    """
    await _ensure_write_worker()
    assert _write_q is not None
    if wait:
        await _run_io(_save_result_sync, result)
    else:
        await _write_q.put(("result", result))
    tokens = result.get("tokens") or {}
    extras = []
    if tokens.get("access_token"):
        extras.append("access_token.txt")
    if tokens.get("refresh_token"):
        extras.append("refresh_token.txt")
    vlog(
        f"queued save → {RESULTS_JSON.name} + {RESULTS_TXT.name}"
        + (f" + {' + '.join(extras)}" if extras else "")
    )


async def save_failed_to_file(attempt: int, email: str, error: str, *, wait: bool = False) -> None:
    """Queue a failed-row write without freezing the HUD."""
    await _ensure_write_worker()
    assert _write_q is not None
    if wait:
        await _run_io(_save_failed_sync, attempt, email, error)
    else:
        await _write_q.put(("failed", attempt, email, error))


async def save_refresh_success(acct: dict, tokens: dict, *, wait: bool = False) -> None:
    """Queue refresh-mode token + accounts.json write."""
    await _ensure_write_worker()
    assert _write_q is not None
    if wait:
        await _run_io(_save_refresh_success_sync, acct, tokens)
    else:
        await _write_q.put(("refresh", acct, tokens))


# ── Refresh tokens for existing accounts ─────────────────────────────────────
# When xAI revokes refresh tokens, re-authenticate EXISTING accounts (sign-in
# with their email+password) to mint fresh ones — no new accounts created.
def _collect_existing_accounts() -> list[dict]:
    """Gather every {email, password} we already farmed, from all batches.

    Scans results/**/accounts.json + the top-level accounts.json. Dedups by
    email. Skips accounts with no usable password.
    """
    import glob as _glob
    accounts: list[dict] = []
    seen: set[str] = set()
    sources = sorted(_glob.glob(str(RESULTS_ROOT / "**" / "accounts.json"), recursive=True))
    top = RESULTS_ROOT / "accounts.json"
    if top.is_file() and str(top) not in sources:
        sources.insert(0, str(top))
    for src in sources:
        try:
            data = json.loads(Path(src).read_text(encoding="utf-8"))
        except Exception:
            continue
        if not isinstance(data, list):
            continue
        for acct in data:
            email = (acct.get("email") or "").strip().lower()
            password = acct.get("password") or ""
            if email and password and email not in seen:
                seen.add(email)
                accounts.append({"email": email, "password": password})
    return accounts


async def _refresh_one_account(
    idx: int,
    acct: dict,
    semaphore: asyncio.Semaphore,
    *,
    concurrent: int = 1,
    try_n: int = 1,
    max_tries: int = 1,
) -> tuple[dict | None, str, str]:
    """One refresh attempt for ONE account.

    Returns (result_dict, error_msg, error_tag).
      - success: (dict with tokens, "", "")
      - failure: (None, human message, short tag) — does NOT emit permanent fail;
        the caller decides retry vs final fail so auto-retry can re-queue cleanly.

    Isolation contract (per worker):
      - Own Camoufox process + page (never shared)
      - Own proxy slot when PROXY_POOL is set (round-robin, not shared session)
      - Turnstile solved in-process (no cross-worker semaphore)
      - No mid-flight wait on other workers (only concurrency semaphore)
    """
    email, password = acct["email"], acct["password"]
    async with semaphore:
        manager = None
        page = None
        try:
            # Light stagger on first try of each slot; retries skip long waits.
            sd = effective_spawn_delay(concurrent)
            if sd > 0 and try_n == 1:
                await asyncio.sleep(sd * ((idx - 1) % max(1, concurrent)))
            proxy_url, proxy_id = await next_proxy()
            manager, browser, page = await launch_browser(
                proxy_url,
                purpose="refresh",
                worker_id=idx,
                email=email,
            )
            _frame_set_email(manager, email)
            _plog = "direct"
            if proxy_url:
                try:
                    _u = urlparse(proxy_url if "://" in proxy_url else f"http://{proxy_url}")
                    _plog = f"{_u.scheme}://{_u.hostname}:{_u.port or ''}"
                except Exception:
                    _plog = "proxy"
            emit_progress(
                idx,
                "refresh",
                f"try {try_n}/{max_tries} · re-auth {email}",
                email,
            )
            print(
                f"[{idx}] refresh browser up: {email} "
                f"try={try_n}/{max_tries} proxy={_plog} id={proxy_id or '-'}",
                flush=True,
            )

            async def _reauth_body() -> dict:
                login_ok = await do_email_login(
                    page, email, password, idx, fast=True
                )
                if not login_ok:
                    print(
                        f"[{idx}] login not confirmed for {email} — "
                        f"OAuth will re-drive login (independent path)",
                        flush=True,
                    )
                toks = await obtain_oidc_tokens(
                    page,
                    email,
                    password,
                    idx,
                    fast=True,
                    skip_login=bool(login_ok),
                )
                if ACTIVATE_WEB:
                    try:
                        toks["web_activated"] = await activate_grok_com(
                            page, email, password, idx,
                        )
                    except Exception as _ae:
                        print(f"[{idx}] refresh activate warn: {_ae}", flush=True)
                        toks["web_activated"] = False
                    if not toks.get("web_activated"):
                        raise RuntimeError(
                            "activate_grok_com failed on refresh (CF/login/UI)"
                        )
                return toks

            tokens = await asyncio.wait_for(
                _reauth_body(),
                timeout=REFRESH_TIMEOUT_S,
            )
            if not tokens or not tokens.get("refresh_token"):
                raise RuntimeError("re-auth returned no refresh_token")
            # Same gate as farm: grok-4.5 Responses probe; keep only chat-capable tokens.
            ok, status, detail, credits = await run_chat_probe_with_hud(
                idx, email, str(tokens.get("access_token") or ""),
                context="refresh",
            )
            if not ok:
                # NEVER blacklist on refresh. Blacklist is tempmail-farm only
                # (generator.email re-roll). Refresh re-auths existing accounts
                # (google catch-all, Gmail, or prior temp) — banning the domain
                # would poison google mode (e.g. untaapi.my.id) forever.
                if status == 403 or "permission-denied" in detail.lower():
                    domain = email_domain(email)
                    print(
                        f"[{idx}] chat 403 after refresh @{domain or '?'} — "
                        f"NOT blacklisting (refresh never bans domains). "
                        f"Fail this account only: {detail}",
                        flush=True,
                    )
                raise RuntimeError(f"chat probe failed after refresh: {detail}")
            rem = credits.get("credits_remaining")
            lim = credits.get("credits_limit")
            tokens["chat_ok"] = True
            tokens["chat_probe"] = detail
            tokens["credits_remaining"] = rem
            tokens["credits_limit"] = lim
            tokens["probe_model"] = credits.get("model") or CLI_PROBE_MODEL
            HUD.record_credits(rem, lim)
            cred_s = ""
            if rem is not None or lim is not None:
                cred_s = (
                    f" credits {FarmHUD.fmt_credits(rem)}/"
                    f"{FarmHUD.fmt_credits(lim)}"
                )
            print(
                f"[{idx}] refreshed {email}: access+refresh+chat OK "
                f"(try {try_n}){cred_s}",
                flush=True,
            )
            return (
                {
                    "email": email,
                    "password": password,
                    "tokens": tokens,
                    "verified": True,
                    "verify_status": int(status or 200),
                    "verify_credits_remaining": rem,
                    "verify_credits_limit": lim,
                },
                "",
                "",
            )
        except asyncio.TimeoutError:
            msg = (
                f"timeout {REFRESH_TIMEOUT_S}s "
                f"(Turnstile/login/oauth stuck — often CF on shared IP)"
            )
            print(f"[{idx}] attempt fail {email} try={try_n}/{max_tries}: {msg}", flush=True)
            return None, msg, "Timeout"
        except Exception as e:
            err = str(e).replace("\n", " ").strip()
            low = err.lower()
            if "connection closed" in low or "childframes" in low or "target closed" in low:
                tag = "BrowserCrash"
                msg = f"browser/driver died: {err[:100]}"
            elif "oauth code not captured" in low:
                tag = "OAuthNoCode"
                msg = err[:140]
            else:
                tag = type(e).__name__
                msg = err[:140]
            print(
                f"[{idx}] attempt fail {email} try={try_n}/{max_tries}: {msg}",
                flush=True,
            )
            return None, msg, tag
        finally:
            if manager is not None:
                await close_browser(manager)


async def refresh_tokens_main(concurrent: int) -> int:
    """Top-level: re-auth every existing account, append fresh tokens.

    Auto-retry: on fail the SAME account is retried immediately (new browser +
    short backoff) up to REFRESH_RETRIES times — not sent to the back of the
    queue. Goal is full coverage of the account list.

    Writes new access_token + refresh_token lines to the shared .txt files
    (same ones the farmer appends to). Returns count of accounts refreshed.
    """
    startup_profile_sweep()
    _install_sigint_handler()

    accounts = _collect_existing_accounts()
    if not accounts:
        print("No existing accounts found under results/ — nothing to refresh.", flush=True)
        return 0

    max_accounts = len(accounts)
    concurrent = max(1, min(20, int(concurrent)))
    max_tries = REFRESH_RETRIES
    # Own batch folder so refresh NEVER touches existing accounts.json/failed.json.
    init_batch(max_accounts, concurrent)

    print("=" * 60, flush=True)
    print(f"  Refresh tokens for {max_accounts} existing account(s)", flush=True)
    print(f"  Concurrent: {concurrent}", flush=True)
    print(f"  Retries  : {max_tries} per account (immediate, same slot)", flush=True)
    print(f"  Batch : {BATCH_ID}", flush=True)
    print(f"  Out   : {BATCH_DIR}", flush=True)
    print(f"  AT  : {ACCESS_TOKEN_FILE}", flush=True)
    print(f"  RT  : {REFRESH_TOKEN_FILE}", flush=True)
    print(f"  UI   : {UI_MODE}", flush=True)
    print("=" * 60, flush=True)

    # Truncate token files BEFORE the HUD starts. Any print after HUD.start
    # would shift the cursor and leave stacked leftover frames.
    # Truncate token files + reset in-memory JSON buffers (sync, before HUD)
    for f in (ACCESS_TOKEN_FILE, REFRESH_TOKEN_FILE):
        try:
            f.write_text("", encoding="utf-8")
        except Exception as e:
            print(f"[refresh] could not truncate {f.name}: {e}", flush=True)
    _reset_results_memory([], [])
    print(
        f"[refresh] cleared {ACCESS_TOKEN_FILE.name} + {REFRESH_TOKEN_FILE.name} "
        f"(will hold only fresh tokens)",
        flush=True,
    )

    log_path = BATCH_DIR / "farm.log"
    HUD.open_log(log_path)
    install_quiet_print()
    HUD.start(
        max_accounts,
        batch_id=BATCH_ID,
        batch_dir=str(BATCH_DIR),
        mode=f"refresh×{max_tries}",
    )
    # CLI-style OAuth: real localhost callback on :56121 (same as Grok CLI)
    await ensure_cli_oauth_server()

    sem = asyncio.Semaphore(concurrent)
    start = time.time()
    refreshed = 0
    failed = 0
    retried = 0  # number of re-queue events (not unique accounts)
    interrupted = False
    tasks: list[asyncio.Task] = []
    tick: asyncio.Task | None = None
    counter_lock = asyncio.Lock()

    # Work queue: (stable_idx, account) — each account once.
    # Retries happen IN-PLACE on the same worker (not back of queue):
    #   fail → close browser → backoff → new browser → try again.
    work_q: asyncio.Queue = asyncio.Queue()
    for i, acct in enumerate(accounts):
        work_q.put_nowait((i + 1, acct))

    async def _save_success(idx: int, acct: dict, res: dict) -> None:
        nonlocal refreshed
        # Queue disk write — does not block event loop / HUD
        await save_refresh_success(acct, res["tokens"])
        async with counter_lock:
            refreshed += 1
        rem = res.get("verify_credits_remaining")
        lim = res.get("verify_credits_limit")
        if rem is None and isinstance(res.get("tokens"), dict):
            rem = res["tokens"].get("credits_remaining")
            lim = res["tokens"].get("credits_limit")
        cred_msg = ""
        if rem is not None or lim is not None:
            cred_msg = (
                f" · credits {FarmHUD.fmt_credits(rem)}/"
                f"{FarmHUD.fmt_credits(lim)}"
            )
        emit_success(idx, acct["email"], f"refreshed + CLI OK{cred_msg}")

    async def worker(worker_id: int) -> None:
        """Pull one account; retry it immediately on fail until OK or max_tries."""
        nonlocal failed, retried
        while True:
            item = await work_q.get()
            if item is None:
                work_q.task_done()
                return
            idx, acct = item
            email = acct["email"]
            try:
                last_err, last_tag = "", ""
                for try_n in range(1, max_tries + 1):
                    res, err, tag = await _refresh_one_account(
                        idx,
                        acct,
                        sem,
                        concurrent=concurrent,
                        try_n=try_n,
                        max_tries=max_tries,
                    )
                    if res:
                        await _save_success(idx, acct, res)
                        break

                    last_err, last_tag = err, tag
                    if try_n >= max_tries:
                        async with counter_lock:
                            failed += 1
                        final_msg = (
                            f"gave up after {max_tries} tries: "
                            f"{last_err or last_tag or 'unknown'}"
                        )
                        print(
                            f"[{idx}] PERMANENT FAIL {email}: {final_msg}",
                            flush=True,
                        )
                        emit_failed(idx, final_msg, last_tag or "RefreshFail")
                        try:
                            await save_failed_to_file(idx, email, final_msg)
                        except Exception:
                            pass
                        break

                    # Immediate retry on SAME account (do not send to queue end)
                    async with counter_lock:
                        retried += 1
                    next_try = try_n + 1
                    backoff = REFRESH_RETRY_BACKOFF_S * try_n
                    emit_progress(
                        idx,
                        "retry",
                        f"fail try {try_n}/{max_tries}: {(err or tag)[:48]} · "
                        f"retry now in {backoff:.0f}s → {next_try}/{max_tries}",
                        email,
                    )
                    print(
                        f"[{idx}] immediate retry {email} "
                        f"{try_n}/{max_tries} → {next_try}/{max_tries} "
                        f"after {backoff:.1f}s ({tag}: {err})",
                        flush=True,
                    )
                    await asyncio.sleep(backoff)
                    # loop continues → new browser for next try
            finally:
                work_q.task_done()

    try:
        # concurrent workers pull from shared queue; semaphore caps live browsers.
        n_workers = concurrent
        tasks = [asyncio.create_task(worker(i + 1)) for i in range(n_workers)]
        tick = asyncio.create_task(HUD.ticker())
        # Wait until every account is success or permanent-fail.
        await work_q.join()
        # Wake workers blocked on get() so they exit cleanly.
        for _ in range(n_workers):
            await work_q.put(None)
        await asyncio.gather(*tasks)
    except (KeyboardInterrupt, asyncio.CancelledError):
        interrupted = True
    finally:
        try:
            await _cancel_tasks_quiet(
                list(tasks) + ([tick] if tick is not None else []),
                timeout=2.0,
            )
        except Exception:
            pass
        try:
            restore_quiet_print()
        except Exception:
            pass
        try:
            # Drain pending disk writes before exit so no results are lost
            await stop_result_writer()
        except Exception:
            pass
        try:
            await stop_cli_oauth_server()
        except Exception:
            pass
        try:
            HUD.stop()
            HUD.close_log()
        except Exception:
            pass
        # Always kill leftover browsers + wipe temp profiles (PID tree + owned dirs)
        try:
            session_cleanup(
                "refresh-interrupt" if interrupted else "refresh-finish"
            )
        except Exception as e:
            print(f"[cleanup] session_cleanup failed: {e}", flush=True)

    if interrupted:
        print("\n[refresh] Ctrl+C — cancelled workers.", flush=True)
        print(
            f"  Interrupted: {refreshed}/{max_accounts} refreshed, "
            f"{failed} permanent fail, {retried} immediate retries "
            f"in {int(time.time() - start)}s",
            flush=True,
        )
        os._exit(130)

    print("=" * 60, flush=True)
    print(
        f"  DONE: {refreshed}/{max_accounts} refreshed, {failed} permanent fail, "
        f"{retried} immediate retries in {int(time.time() - start)}s",
        flush=True,
    )
    if failed:
        print(
            f"  (still failing after {max_tries} tries each — "
            f"raise GROK_REFRESH_RETRIES or add proxies)",
            flush=True,
        )
    print("=" * 60, flush=True)
    return refreshed


def _prompt_int(label: str, default: int, *, min_v: int = 1, max_v: int = 100000) -> int:
    """Ask user for an int; Enter keeps default from .env."""
    while True:
        try:
            raw = input(f"  {label} [{default}]: ").strip()
        except EOFError:
            return default
        if raw == "":
            val = default
        else:
            try:
                val = int(raw)
            except ValueError:
                print(f"    → masukkan angka (min {min_v}, max {max_v})", flush=True)
                continue
        if val < min_v or val > max_v:
            print(f"    → harus antara {min_v}–{max_v}", flush=True)
            continue
        return val


def _prompt_yes_no(label: str, default: bool = True) -> bool:
    hint = "Y/n" if default else "y/N"
    try:
        raw = input(f"  {label} [{hint}]: ").strip().lower()
    except EOFError:
        return default
    if raw == "":
        return default
    return raw in ("y", "yes", "1", "true")


async def main():
    global MAIL_MODE
    # Clean orphan profile dirs from prior crashed runs + arm the Ctrl+C
    # backstop BEFORE any browser can launch.
    try:
        startup_profile_sweep()
    except Exception as e:
        print(f"[cleanup] startup sweep failed: {e}", flush=True)
    _install_sigint_handler()
    if MAIL_MODE == "google":
        if not IMAP_USER or not IMAP_PASS:
            print("ERROR: set GROK_IMAP_USER and GROK_IMAP_PASS in .env (or use temp mail)", flush=True)
            sys.exit(1)
    if EMAIL_MODE == "domain" and not EMAIL_DOMAIN:
        print("ERROR: set GROK_EMAIL_DOMAIN for domain mode", flush=True)
        sys.exit(1)
    if EMAIL_MODE == "plus_trick" and not (GMAIL_BASE or IMAP_USER):
        print("ERROR: set GROK_GMAIL_BASE or GROK_IMAP_USER for plus_trick", flush=True)
        sys.exit(1)

    _load_used_emails()
    known = len(_used_emails)

    print("=" * 60, flush=True)
    print("  Grok / xAI Standalone Farmer", flush=True)
    print("=" * 60, flush=True)
    print(f"  Mail mode  : {MAIL_MODE}", flush=True)
    if MAIL_MODE == "tempmail":
        print(f"  Temp mail  : generator.email (headless={TEMPMAIL_HEADLESS})", flush=True)
        print(f"  OTP source : temp-mail inbox page (no IMAP)", flush=True)
    else:
        print(f"  Email mode : {EMAIL_MODE}", flush=True)
        if EMAIL_MODE == "domain":
            print(f"  Domain     : @{EMAIL_DOMAIN}", flush=True)
        else:
            print(f"  Gmail base : {GMAIL_BASE or IMAP_USER}", flush=True)
        print(f"  IMAP       : {IMAP_USER} @ {IMAP_HOST}:{IMAP_PORT}", flush=True)
    print(f"  Password   : {'*' * max(0, len(ACCOUNT_PASSWORD) - 2)}{ACCOUNT_PASSWORD[-2:]}", flush=True)
    print(f"  Headless   : {HEADLESS}", flush=True)
    print(f"  Activate   : {ACTIVATE_WEB}", flush=True)
    print(
        f"  Isolation  : {WORKER_ISOLATION} "
        f"(own browser/Turnstile; spawn_delay={SPAWN_DELAY}s; "
        f"ts_parallel={TURNSTILE_PARALLEL})",
        flush=True,
    )
    print(
        f"  Load guard : launch_parallel={LAUNCH_PARALLEL} "
        f"auto_stagger={AUTO_STAGGER}/{AUTO_SPAWN_DELAY_S}s "
        f"tempmail_block_images={TEMPMAIL_BLOCK_IMAGES}",
        flush=True,
    )
    # Banner uses .env default; final concurrent is chosen after prompts below
    _conc_hint = max(1, CONCURRENT)
    _est = _conc_hint * (2 if MAIL_MODE == "tempmail" else 1)
    if _conc_hint > 3:
        print(
            f"  WARN       : concurrent≈{_conc_hint} → ~{_est} browsers; "
            f"home net often bottlenecks OAuth/activate. Prefer c=2–3, "
            f"LAUNCH_PARALLEL=2, or residential proxies.",
            flush=True,
        )
    elif _conc_hint >= 3:
        print(
            f"  Tip        : concurrent≈{_conc_hint} (~{_est} browsers) — "
            f"OK if launch_parallel≤2; raise SPAWN_DELAY if pages stall.",
            flush=True,
        )
    print(
        f"  Self-heal  : ui_retries={UI_RETRIES} probe_retries={PROBE_RETRIES}",
        flush=True,
    )
    print(
        f"  Proxies    : {len(PROXY_POOL)} ({PROXY_SOURCE})"
        if PROXY_POOL
        else f"  Proxies    : direct ({PROXY_SOURCE})",
        flush=True,
    )
    print(f"  Email len  : {EMAIL_LOCAL_LEN} (crypto secrets)", flush=True)
    print(f"  Known mail : {known} (all batches + used_emails.txt)", flush=True)
    print(f"  Results    : {RESULTS_ROOT}/batch_<id>/  (per run)", flush=True)
    print("-" * 60, flush=True)
    print("  Setting run (Enter = pakai default dari .env)", flush=True)

    # CLI args override: python farm.py -m tempmail --count 10 --concurrent 2 --yes
    arg_count: int | None = None
    arg_conc: int | None = None
    arg_mail: str | None = None
    skip_prompt = False
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        a = args[i]
        if a in ("-n", "--count", "--max") and i + 1 < len(args):
            arg_count = int(args[i + 1])
            i += 2
            continue
        if a in ("-c", "--concurrent") and i + 1 < len(args):
            arg_conc = int(args[i + 1])
            i += 2
            continue
        if a in ("-m", "--mail") and i + 1 < len(args):
            arg_mail = args[i + 1].strip().lower()
            i += 2
            continue
        if a in ("-y", "--yes", "--non-interactive"):
            skip_prompt = True
            i += 1
            continue
        if a in ("-h", "--help"):
            print(
                "Usage: farm.py [-m tempmail|google|refresh] [-n COUNT] [-c CONCURRENT] [-y]\n"
                "  -m/--mail         tempmail | google | refresh\n"
                "                    tempmail = buat akun baru via generator.email\n"
                "                    google   = buat akun baru via Gmail+IMAP\n"
                "                    refresh  = re-auth akun LAMA -> refresh token baru\n"
                "  -n/--count        jumlah akun batch ini (default: tanya / .env)\n"
                "  -c/--concurrent   browser paralel (default: tanya / .env)\n"
                "  -y/--yes          non-interactive, pakai .env / flags saja\n"
                "Each run writes to results/batch_<timestamp>/ (fresh files).\n"
                "Emails stay unique across batches via results/used_emails.txt",
                flush=True,
            )
            sys.exit(0)
        i += 1

    # ── Mode selection: [1] temp mail, [2] google, [3] refresh tokens ─────
    RUN_MODE = "farm"  # farm (create new) or refresh (re-auth existing)
    if arg_mail is not None:
        if arg_mail in ("refresh", "refresh-token", "reauth", "3"):
            RUN_MODE = "refresh"
        elif arg_mail in ("tempmail", "google", "temp", "1", "2"):
            MAIL_MODE = "tempmail" if arg_mail in ("tempmail", "temp", "1") else "google"
        else:
            print(f"ERROR: -m/--mail must be tempmail|google|refresh (got {arg_mail!r})", flush=True)
            sys.exit(1)
    elif not skip_prompt:
        print()
        print("  Pilih mode:")
        print("    [1] Temp mail   (buat akun baru, generator.email)")
        print("    [2] Google      (buat akun baru, Gmail + IMAP)")
        print("    [3] Refresh     (re-auth akun lama -> refresh token baru)")
        while True:
            try:
                choice = input(f"  Pilih [1/2/3]: ").strip().lower()
            except EOFError:
                break
            if choice in ("1", "tempmail", "temp", "t"):
                MAIL_MODE = "tempmail"
                break
            if choice in ("2", "google", "g"):
                MAIL_MODE = "google"
                break
            if choice in ("3", "refresh", "r"):
                RUN_MODE = "refresh"
                break
            if choice == "":
                break  # keep GROK_MAIL_MODE default (farm)
            print("  Masukkan 1, 2, atau 3.")
        print()

    # Re-validate config now that MAIL_MODE is final.
    if MAIL_MODE == "google" and (not IMAP_USER or not IMAP_PASS):
        print("ERROR: google mode but GROK_IMAP_USER / GROK_IMAP_PASS missing in .env", flush=True)
        sys.exit(1)

    # ── Refresh mode: re-auth existing accounts, then exit (no farming) ────
    if RUN_MODE == "refresh":
        if skip_prompt:
            concurrent = arg_conc if arg_conc is not None else CONCURRENT
        else:
            concurrent = arg_conc if arg_conc is not None else _prompt_int(
                "Concurrency (browser paralel)?", CONCURRENT, min_v=1, max_v=20
            )
        concurrent = max(1, min(20, int(concurrent)))
        try:
            await refresh_tokens_main(concurrent)
        except KeyboardInterrupt:
            print("\nInterrupted", flush=True)
        return

    if skip_prompt:
        max_accounts = arg_count if arg_count is not None else MAX_ACCOUNTS
        concurrent = arg_conc if arg_conc is not None else CONCURRENT
    else:
        max_accounts = arg_count if arg_count is not None else _prompt_int(
            "Berapa akun yang mau di-farm (batch ini)?", MAX_ACCOUNTS, min_v=1, max_v=100000
        )
        concurrent = arg_conc if arg_conc is not None else _prompt_int(
            "Concurrency (browser paralel)?", CONCURRENT, min_v=1, max_v=20
        )
        if not _prompt_yes_no(f"Mulai farm {max_accounts} akun × concurrent {concurrent}?", True):
            print("  Dibatalkan.", flush=True)
            sys.exit(0)

    max_accounts = max(1, min(100000, int(max_accounts)))
    concurrent = max(1, min(20, int(concurrent)))

    # Fresh batch folder for this run (results isolated per batch)
    init_batch(max_accounts, concurrent)
    # this batch starts empty — count is "how many this run", not cumulative
    target = max_accounts

    print("-" * 60, flush=True)
    print(f"  Batch      : {BATCH_ID}", flush=True)
    print(f"  Create     : {max_accounts} accounts (concurrent={concurrent})", flush=True)
    print(f"  Out        : {BATCH_DIR}", flush=True)
    print(f"  UI         : {UI_MODE}" + (" + verbose" if VERBOSE else ""), flush=True)
    print("=" * 60, flush=True)

    # Full detail always lands in batch farm.log; HUD keeps terminal clean
    log_path = BATCH_DIR / "farm.log"
    HUD.open_log(log_path)
    install_quiet_print()
    HUD.start(
        max_accounts,
        batch_id=BATCH_ID,
        batch_dir=str(BATCH_DIR),
        mode=f"farm/{MAIL_MODE}",
    )
    # CLI-style OAuth: real localhost callback on :56121 (same as Grok CLI)
    await ensure_cli_oauth_server()

    semaphore = asyncio.Semaphore(concurrent)
    created = 0
    failed = 0
    next_attempt = 1
    counter_lock = asyncio.Lock()
    start = time.time()
    workers: list[asyncio.Task] = []
    tick: asyncio.Task | None = None
    interrupted = False

    async def worker():
        nonlocal created, failed, next_attempt
        while True:
            async with counter_lock:
                if next_attempt > target:
                    return
                num = next_attempt
                next_attempt += 1
            # Stagger worker *starts* so page-loads don't all hit the uplink at once
            sd = effective_spawn_delay(concurrent)
            if sd > 0:
                await asyncio.sleep(sd * ((num - 1) % max(1, concurrent)))
            res = await register_one_account(num, semaphore)
            async with counter_lock:
                if res:
                    created += 1
                else:
                    failed += 1
            # HUD already updated via emit_success / emit_failed

    try:
        workers = [asyncio.create_task(worker()) for _ in range(concurrent)]
        tick = asyncio.create_task(HUD.ticker())
        await asyncio.gather(*workers)
    except (KeyboardInterrupt, asyncio.CancelledError):
        # Ctrl+C: SIGINT already force-killed browsers. Cancel fast.
        interrupted = True
    finally:
        try:
            await _cancel_tasks_quiet(
                list(workers) + ([tick] if tick is not None else []),
                timeout=2.0,
            )
        except Exception:
            pass
        try:
            restore_quiet_print()
        except Exception:
            pass
        try:
            # Drain pending disk writes before exit so no results are lost
            await stop_result_writer()
        except Exception:
            pass
        try:
            await stop_cli_oauth_server()
        except Exception:
            pass
        try:
            HUD.stop()
            HUD.close_log()
        except Exception:
            pass
        # Always kill leftover browsers + wipe temp profiles (PID tree + owned dirs)
        try:
            session_cleanup("farm-interrupt" if interrupted else "farm-finish")
        except Exception as e:
            if not interrupted:
                print(f"[cleanup] session_cleanup failed: {e}", flush=True)

    if interrupted:
        print("\n[farm] Ctrl+C — cancelled workers.", flush=True)
        print(
            f"  Interrupted: {created} created, {failed} failed "
            f"in {int(time.time() - start)}s",
            flush=True,
        )
        # Hard exit after cleanup — avoids Playwright pending-task teardown spam.
        os._exit(130)

    # finalize batch meta
    try:
        meta_path = BATCH_DIR / "batch_meta.json"
        meta = {}
        if meta_path.is_file():
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        meta.update({
            "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "created": created,
            "failed": failed,
            "elapsed_s": int(time.time() - start),
        })
        meta_path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    except Exception:
        pass

    print("=" * 60, flush=True)
    print(f"  DONE: {created} created, {failed} failed in {int(time.time() - start)}s", flush=True)
    print(f"  Batch: {BATCH_ID}", flush=True)
    print(f"  Dir  : {BATCH_DIR}", flush=True)
    print(f"  JSON : {RESULTS_JSON}", flush=True)
    print(f"  TXT  : {RESULTS_TXT}", flush=True)
    print(f"  AT   : {ACCESS_TOKEN_FILE}", flush=True)
    print(f"  RT   : {REFRESH_TOKEN_FILE}", flush=True)
    if MAIL_MODE == "tempmail":
        print(f"  BL   : {BLACKLIST_FILE}", flush=True)
    print(f"  Log  : {log_path}", flush=True)
    print(f"  Used : {USED_EMAILS_FILE}", flush=True)
    print("=" * 60, flush=True)


if __name__ == "__main__":
    # Camoufox under /root/.cache is often incomplete → "Couldn't load XPCOM"
    if hasattr(os, "geteuid") and os.geteuid() == 0:
        print(
            "ERROR: jangan jalankan farm sebagai root/sudo.\n"
            "  Pakai user yang install Camoufox (biasanya priyo), bukan root.\n"
            "  Root's ~/.cache/camoufox is incomplete → XPCOM launch crash.",
            flush=True,
        )
        sys.exit(1)
    # Register atexit early so any exit path still cleans browsers/temp.
    try:
        _register_atexit_cleanup()
    except Exception:
        pass
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        try:
            restore_quiet_print()
        except Exception:
            pass
        try:
            session_cleanup("main-keyboardinterrupt")
        except Exception:
            pass
        try:
            print("Interrupted", flush=True)
        except Exception:
            pass
        # Skip asyncio loop teardown over dead Playwright tasks.
        os._exit(130)
    except SystemExit:
        try:
            restore_quiet_print()
        except Exception:
            pass
        try:
            session_cleanup("main-systemexit")
        except Exception:
            pass
        raise
    finally:
        try:
            restore_quiet_print()
        except Exception:
            pass
        try:
            session_cleanup("main-finally")
        except Exception:
            pass
