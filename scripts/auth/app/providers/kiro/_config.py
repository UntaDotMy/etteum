from __future__ import annotations

import os
import re
import ssl
from pathlib import Path

_SSL_CTX = ssl.create_default_context()
_SSL_CTX.check_hostname = False
_SSL_CTX.verify_mode = ssl.CERT_NONE

_EMAIL_PATTERN = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

KIRO_AUTH_BASE = os.getenv(
    "BATCHER_KIRO_AUTH_BASE", "https://prod.us-east-1.auth.desktop.kiro.dev"
)
KIRO_LOGIN_ENDPOINT = os.getenv(
    "BATCHER_KIRO_LOGIN_ENDPOINT", f"{KIRO_AUTH_BASE}/login"
)
KIRO_TOKEN_ENDPOINT = os.getenv(
    "BATCHER_KIRO_TOKEN_ENDPOINT", f"{KIRO_AUTH_BASE}/oauth/token"
)
KIRO_REGION = os.getenv("BATCHER_KIRO_REGION", "us-east-1")
KIRO_REDIRECT_URI = os.getenv(
    "BATCHER_KIRO_REDIRECT_URI",
    "kiro://kiro.kiroAgent/authenticate-success",
)
KIRO_USAGE_ENDPOINT = os.getenv(
    "BATCHER_KIRO_USAGE_ENDPOINT",
    "https://q.us-east-1.amazonaws.com/getUsageLimits",
)
KIRO_REFRESH_ENDPOINT = os.getenv(
    "BATCHER_KIRO_REFRESH_ENDPOINT",
    f"https://prod.{KIRO_REGION}.auth.desktop.kiro.dev/refreshToken",
)
KIRO_CLIENT_OS_POOL = ("windows", "macos", "linux")
KIRO_FALLBACK_USER_AGENTS = {
    "windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:150.0) Gecko/20100101 Firefox/150.0",
    "macos": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:150.0) Gecko/20100101 Firefox/150.0",
    "linux": "Mozilla/5.0 (X11; Linux x86_64; rv:150.0) Gecko/20100101 Firefox/150.0",
}
