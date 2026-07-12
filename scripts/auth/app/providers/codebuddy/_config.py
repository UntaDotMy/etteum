from __future__ import annotations

import os
import re
from pathlib import Path
from urllib.parse import urlparse

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

# scripts/auth/cookies — portable relative to this package
COOKIES_DIR = Path(__file__).resolve().parents[3] / "cookies"
COOKIES_DIR.mkdir(exist_ok=True)

CODEBUDDY_BASE_URL = os.getenv("BATCHER_CODEBUDDY_BASE_URL", "https://www.codebuddy.ai")
CODEBUDDY_PLATFORM = (
    os.getenv("BATCHER_CODEBUDDY_PLATFORM", "IDE").strip().upper() or "IDE"
)
CODEBUDDY_FETCH_QUOTA_ENABLED = (
    os.getenv("BATCHER_CODEBUDDY_FETCH_QUOTA", "false").lower() == "true"
)
CODEBUDDY_STATE_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_STATE_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/v2/plugin/auth/state?platform={CODEBUDDY_PLATFORM}",
)
CODEBUDDY_TOKEN_POLL_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_TOKEN_POLL_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/v2/plugin/auth/token",
)
CODEBUDDY_LOGIN_ACCOUNT_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_LOGIN_ACCOUNT_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/v2/plugin/login/account",
)
CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_CONSOLE_LOGIN_ACCOUNT_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/login/account",
)
CODEBUDDY_ACCOUNTS_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_ACCOUNTS_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/v2/plugin/accounts",
)
CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_CONSOLE_ACCOUNTS_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/accounts",
)
CODEBUDDY_CONSOLE_VALIDATE_REFRESH_TOKEN_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_CONSOLE_VALIDATE_REFRESH_TOKEN_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/validate/refresh-token",
)
CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_CONSOLE_LOGIN_ENTERPRISE_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/login/enterprise",
)
CODEBUDDY_CONSOLE_AUTH_LOGIN_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_CONSOLE_AUTH_LOGIN_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/auth/login",
)
CODEBUDDY_USER_RESOURCE_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_USER_RESOURCE_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/billing/meter/get-user-resource",
)
CODEBUDDY_API_KEYS_ENDPOINT = os.getenv(
    "BATCHER_CODEBUDDY_API_KEYS_ENDPOINT",
    f"{CODEBUDDY_BASE_URL}/console/api/client/v1/api-keys",
)
CODEBUDDY_REDIRECT_SCHEME = os.getenv(
    "BATCHER_CODEBUDDY_REDIRECT_SCHEME", "codebuddy://"
)
CODEBUDDY_POLL_INTERVAL_SECONDS = float(
    os.getenv("BATCHER_CODEBUDDY_POLL_INTERVAL_SECONDS", "2")
)
CODEBUDDY_POLL_TIMEOUT_SECONDS = float(
    os.getenv("BATCHER_CODEBUDDY_POLL_TIMEOUT_SECONDS", "180")
)
# Keep native CodeBuddy flow by default:
# after Google login, CodeBuddy should route to region page when needed.
CODEBUDDY_FORCE_REGION_POST_AUTH = (
    os.getenv("BATCHER_CODEBUDDY_FORCE_REGION_POST_AUTH", "false").lower() == "true"
)

CLI_HEADERS = {
    "X-Requested-With": "XMLHttpRequest",
    "User-Agent": "CLI/2.54.0 CodeBuddy/2.54.0",
}


def _get_proxy_url() -> str | None:
    return (
        os.getenv("BATCHER_PROXY_URL")
        or os.getenv("HTTPS_PROXY")
        or os.getenv("HTTP_PROXY")
        or None
    )


def _make_proxy_connector() -> Any:
    url = _get_proxy_url()
    if not url:
        return None
    if url.startswith("socks"):
        try:
            from aiohttp_socks import ProxyConnector

            return ProxyConnector.from_url(url)
        except ImportError:
            return None
    return None


def _make_session(timeout: Any, headers: dict[str, str]) -> "aiohttp.ClientSession":
    connector = _make_proxy_connector()
    proxy_url = _get_proxy_url()
    kwargs: dict[str, Any] = {"timeout": timeout, "headers": headers}
    if connector:
        kwargs["connector"] = connector
    session = aiohttp.ClientSession(**kwargs)
    session._proxy_url = proxy_url if not connector else None  # type: ignore[attr-defined]
    return session


def _req_proxy(session: "aiohttp.ClientSession") -> str | None:
    return getattr(session, "_proxy_url", None)


WEB_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "X-Requested-With": "XMLHttpRequest",
    "X-Domain": urlparse(CODEBUDDY_BASE_URL).netloc,
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
        "(KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36"
    ),
}

EMAIL_SELECTORS = [
    "#identifierId",
    'input[name="identifier"]',
    'input[type="email"]',
    'input[name="email"]',
    'input[autocomplete="username"]',
]

PASSWORD_SELECTORS = [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="Passwd"]',
    'input[autocomplete="current-password"]',
]

