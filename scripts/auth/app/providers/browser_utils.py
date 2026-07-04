"""Shared browser utilities for nodriver-based providers."""

from __future__ import annotations


def raise_browser_unavailable(provider: str) -> None:
    """Raise a clear NonRetryableBatcherError marking a provider's browser
    automation as unavailable.

    Camoufox (Firefox) and Chromium/Playwright have been removed from this repo
    in favor of nodriver. Only the `antigravity` provider has been migrated to
    nodriver so far. The other browser providers (kiro, codex, qoder, codebuddy,
    canva, gitlab-duo, kiro-pro, wavespeed, yepapi) are DISABLED until their
    nodriver migration is done. Call this at the top of each unmigrated
    provider's bootstrap_session.

    Default browser engine is now nodriver.
    """
    from app.errors.codes import ErrorCode
    from app.errors.exceptions import NonRetryableBatcherError
    raise NonRetryableBatcherError(
        ErrorCode.browser_start_failed,
        f"{provider}: browser automation unavailable — nodriver migration pending "
        f"(only 'antigravity' is migrated).",
    )
