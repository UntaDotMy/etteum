#!/usr/bin/env python3
"""Pure helpers for Grok farm — no browser, no Camoufox.

Importable without camoufox so unit tests and diagnose mode stay light.
"""
from __future__ import annotations

import base64
import json
import os
import re
import stat
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import unquote, urlparse

# ── Proxy ────────────────────────────────────────────────────────────────────

def normalize_proxy_url(raw: str) -> str | None:
    """Turn free-form proxy string into a URL Camoufox/Playwright accepts."""
    s = (raw or "").strip()
    if not s:
        return None
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    if not s:
        return None
    if "://" in s:
        return s
    parts = s.split(":")
    # host:port:user:pass
    if len(parts) >= 4 and parts[1].isdigit() and "@" not in parts[0]:
        host, port, user = parts[0], parts[1], parts[2]
        password = ":".join(parts[3:])
        if host and user:
            return f"http://{user}:{password}@{host}:{port}"
    if "@" in s:
        return f"http://{s}"
    if len(parts) == 2 and parts[1].isdigit():
        return f"http://{parts[0]}:{parts[1]}"
    return None


def parse_proxy_entry(item: str) -> tuple[str, str] | None:
    """Parse one proxy entry → (url, optional_id) or None."""
    item = (item or "").strip()
    if not item or item.startswith("#"):
        return None
    pid = ""
    if " #" in item:
        item, _, comment = item.partition(" #")
        item = item.strip()
        pid = comment.strip()
    elif item.count("#") == 1 and "://" in item:
        url_part, _, maybe_id = item.partition("#")
        item, pid = url_part.strip(), maybe_id.strip()
    url = normalize_proxy_url(item)
    if not url:
        return None
    return (url, pid)


def parse_proxy_for_playwright(url: str) -> dict[str, Any]:
    """Playwright/Camoufox proxy dict from URL."""
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


def proxy_scheme(proxy_url: str | None) -> str:
    if not proxy_url:
        return ""
    try:
        u = urlparse(proxy_url if "://" in proxy_url else f"http://{proxy_url}")
        return (u.scheme or "http").lower()
    except Exception:
        return ""


def build_urllib_opener(proxy_url: str | None = None):
    """urllib opener that optionally tunnels via proxy.

    HTTP(S) proxies: stdlib ProxyHandler.
    SOCKS: requires PySocks (optional); else returns default opener and caller
    should treat proxy as unavailable for non-browser HTTP.
    """
    if not proxy_url:
        return urllib.request.build_opener()
    scheme = proxy_scheme(proxy_url)
    if scheme.startswith("socks"):
        try:
            import socks  # type: ignore
            from urllib.request import build_opener
            from sockshandler import SocksiPyHandler  # type: ignore

            u = urlparse(proxy_url if "://" in proxy_url else f"socks5://{proxy_url}")
            stype = socks.SOCKS5 if "5" in scheme else socks.SOCKS4
            handler = SocksiPyHandler(
                stype,
                u.hostname,
                int(u.port or 1080),
                username=unquote(u.username) if u.username else None,
                password=unquote(u.password) if u.password else None,
            )
            return build_opener(handler)
        except Exception:
            # Fall through to direct — browser still uses socks via Camoufox
            return urllib.request.build_opener()
    # http / https proxy
    proxy_handler = urllib.request.ProxyHandler({
        "http": proxy_url,
        "https": proxy_url,
    })
    return urllib.request.build_opener(proxy_handler)


def urlopen(
    req: urllib.request.Request,
    *,
    timeout: float = 30,
    proxy_url: str | None = None,
):
    """urlopen with optional proxy (same egress as browser when possible)."""
    opener = build_urllib_opener(proxy_url)
    return opener.open(req, timeout=timeout)


# ── OTP ──────────────────────────────────────────────────────────────────────

_XAI_CODE_RE = re.compile(r"\b([A-Z0-9]{3}-[A-Z0-9]{3})\b", re.I)
_XAI_SUBJ_CODE_RE = re.compile(
    r"^\s*([A-Z0-9]{3}-[A-Z0-9]{3})\s+xAI\s+confirmation", re.I
)
_CSS_OTP_DENY = frozenset({
    "PER-100", "RGB-255", "PX-16", "EM-16", "REM-16", "MS-300", "MS-200",
})


def is_plausible_xai_otp(code: str) -> bool:
    """Accept real xAI codes; reject CSS noise (PER-100, RGB-255, PX-16)."""
    code = (code or "").upper().strip()
    if not re.fullmatch(r"[A-Z0-9]{3}-[A-Z0-9]{3}", code):
        return False
    left, right = code.split("-", 1)
    if re.fullmatch(r"[A-Z]+", left) and re.fullmatch(r"\d+", right):
        return False
    if re.fullmatch(r"\d+", left) and re.fullmatch(r"\d+", right):
        return False
    if code in _CSS_OTP_DENY:
        return False
    return True


def extract_xai_code(subject: str, body: str) -> str | None:
    m = _XAI_SUBJ_CODE_RE.search(subject or "")
    if m:
        code = m.group(1).upper()
        if is_plausible_xai_otp(code):
            return code
    for m in _XAI_CODE_RE.finditer(subject or ""):
        code = m.group(1).upper()
        if is_plausible_xai_otp(code):
            return code
    plain = body or ""
    plain = re.sub(r"<style[\s\S]*?</style>", " ", plain, flags=re.I)
    plain = re.sub(r"<script[\s\S]*?</script>", " ", plain, flags=re.I)
    plain = re.sub(r"<[^>]+>", " ", plain)
    for m in _XAI_CODE_RE.finditer(plain):
        code = m.group(1).upper()
        if is_plausible_xai_otp(code):
            return code
    m = re.search(r"\b(\d{6})\b", plain)
    return m.group(1) if m else None


# ── JWT / probe headers ──────────────────────────────────────────────────────

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


def claim_bits(access_token: str) -> list[str]:
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


def parse_rate_limit_credits(headers) -> dict[str, Any]:
    """Extract free Build token quota from response headers."""
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


def rate_limit_bits(credits: dict[str, Any]) -> list[str]:
    bits: list[str] = []
    if credits.get("credits_remaining") is not None:
        bits.append(f"credits_remaining={int(credits['credits_remaining'])}")
    if credits.get("credits_limit") is not None:
        bits.append(f"credits_limit={int(credits['credits_limit'])}")
    if credits.get("req_remaining") is not None:
        bits.append(f"req_remaining={int(credits['req_remaining'])}")
    return bits


def email_domain(email: str) -> str:
    if not email or "@" not in email:
        return ""
    return email.rsplit("@", 1)[-1].strip().lower().lstrip("@")


# ── Filesystem ───────────────────────────────────────────────────────────────

def secure_chmod_file(path) -> None:
    """Restrict token/result files to owner read/write when OS supports it."""
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 0o600
    except (OSError, NotImplementedError, AttributeError):
        pass


def finalize_batch_meta(
    meta_path,
    *,
    created: int,
    failed: int,
    elapsed_s: int,
    interrupted: bool = False,
    extra: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Merge finish stats into batch_meta.json (interrupt-safe)."""
    from datetime import datetime, timezone
    from pathlib import Path

    path = Path(meta_path)
    meta: dict[str, Any] = {}
    if path.is_file():
        try:
            raw = json.loads(path.read_text(encoding="utf-8") or "{}")
            if isinstance(raw, dict):
                meta = raw
        except Exception:
            meta = {}
    meta.update({
        "finished_at": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "created": int(created),
        "failed": int(failed),
        "elapsed_s": int(elapsed_s),
        "interrupted": bool(interrupted),
        "status": "interrupted" if interrupted else "finished",
    })
    if extra:
        for k, v in extra.items():
            if v is not None:
                meta[k] = v
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(meta, indent=2) + "\n", encoding="utf-8")
    secure_chmod_file(path)
    return meta
