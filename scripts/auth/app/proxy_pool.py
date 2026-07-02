"""Rotating proxy pool for batcher providers.

Reads proxy list from BATCHER_PROXY_POOL (comma-separated URLs) or falls back
to single BATCHER_PROXY_URL. Provides round-robin rotation and retry-with-next
on failure.
"""
from __future__ import annotations

import os
import random
import threading
from itertools import cycle
from typing import Iterator


_lock = threading.Lock()
_pool: list[str] = []
_cycle: Iterator[str] | None = None


def _init_pool() -> list[str]:
    global _pool, _cycle
    pool_env = os.getenv("BATCHER_PROXY_POOL", "")
    if pool_env:
        _pool = [u.strip() for u in pool_env.split(",") if u.strip()]
    else:
        single = os.getenv("BATCHER_PROXY_URL", "")
        _pool = [single] if single else []

    if _pool:
        random.shuffle(_pool)
        _cycle = cycle(_pool)
    return _pool


def get_next_proxy() -> str | None:
    """Get next proxy URL from pool (round-robin). Returns None if no proxies."""
    global _cycle
    with _lock:
        if _cycle is None:
            _init_pool()
        if _cycle is None:
            return None
        return next(_cycle)


def get_pool_size() -> int:
    with _lock:
        if not _pool:
            _init_pool()
        return len(_pool)


def get_all_proxies() -> list[str]:
    with _lock:
        if not _pool:
            _init_pool()
        return list(_pool)
