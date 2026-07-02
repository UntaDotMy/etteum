"""Shared browser utilities for camoufox-based providers."""

from __future__ import annotations

import os
from typing import Any
from urllib.parse import urlparse


def build_camoufox_kwargs(
    *,
    proxy_url: str = "",
    headless_default: str = "true",
    default_timeout: int = 15000,
    disable_coop: bool = False,
    firefox_user_prefs: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Build the standard camoufox launch kwargs dict.

    Args:
        proxy_url: Proxy URL to use. If empty, reads from BATCHER_PROXY_URL env.
                   Pass explicitly when using a proxy pool.
        headless_default: Default value for BATCHER_CAMOUFOX_HEADLESS env var.
        default_timeout: Page default timeout in ms (stored in returned dict
                         as '_default_timeout' for the caller to apply).
        disable_coop: Enable disable_coop and i_know_what_im_doing flags
                      (needed for OAuth flows with cross-origin redirects).
        firefox_user_prefs: Extra Firefox user prefs to merge in.

    Returns:
        Dict ready to be unpacked into AsyncCamoufox(**kwargs).
        Also includes '_default_timeout' key (pop before passing to AsyncCamoufox).
    """
    from browserforge.fingerprints import Screen

    headless = os.getenv("BATCHER_CAMOUFOX_HEADLESS", headless_default).lower() == "true"

    kwargs: dict[str, Any] = {
        "headless": headless,
        "os": "windows",
        "block_webrtc": True,
        "humanize": False,
        "screen": Screen(max_width=1920, max_height=1080),
    }

    if disable_coop:
        kwargs["disable_coop"] = True
        kwargs["i_know_what_im_doing"] = True

    if firefox_user_prefs:
        kwargs["firefox_user_prefs"] = firefox_user_prefs

    # Resolve proxy
    resolved_proxy = proxy_url or os.getenv("BATCHER_PROXY_URL", "")
    if resolved_proxy:
        parsed = urlparse(resolved_proxy)
        proxy_cfg: dict[str, Any] = {
            "server": f"{parsed.scheme}://{parsed.hostname}:{parsed.port}"
        }
        if parsed.username:
            proxy_cfg["username"] = parsed.username
        if parsed.password:
            proxy_cfg["password"] = parsed.password
        kwargs["proxy"] = proxy_cfg
        kwargs["geoip"] = True

    kwargs["_default_timeout"] = default_timeout
    return kwargs


# Standard Firefox prefs for OAuth-heavy providers (prevents crashes during
# cross-origin navigations and reduces memory pressure in headless mode).
OAUTH_FIREFOX_PREFS: dict[str, Any] = {
    # Disable COOP/COEP at all levels to prevent crashes during OAuth redirects
    "browser.tabs.remote.useCrossOriginOpenerPolicy": False,
    "browser.tabs.remote.useCrossOriginEmbedderPolicy": False,
    # Disable process isolation that causes crashes on cross-origin navigations
    "fission.autostart": False,
    "fission.webContentIsolationStrategy": 0,
    # Disable crash reporter and session restore prompts
    "toolkit.crashreporter.enabled": False,
    "browser.sessionstore.resume_from_crash": False,
    "browser.tabs.crashReporting.sendReport": False,
    # Reduce memory pressure that can cause OOM crashes in headless
    "javascript.options.mem.gc_allocation_threshold_mb": 512,
    "javascript.options.mem.high_water_mark": 128,
    # Disable background tasks that can interfere
    "app.update.enabled": False,
    "browser.safebrowsing.enabled": False,
    "browser.safebrowsing.malware.enabled": False,
    # Network stability
    "network.http.connection-timeout": 60,
    "network.http.response.timeout": 120,
    "dom.ipc.processHangMonitor": False,
}


def is_browser_crash(exc: BaseException) -> bool:
    """Return True if the exception indicates a browser crash or closed connection."""
    exc_str = str(exc).lower()
    return (
        "connection closed" in exc_str
        or "target closed" in exc_str
        or "browser has been closed" in exc_str
        or "browser.close" in exc_str
        or "not connected" in exc_str
        or "execution context was destroyed" in exc_str
        or "context was destroyed" in exc_str
    )
