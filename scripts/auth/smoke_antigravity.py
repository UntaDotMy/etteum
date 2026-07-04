#!/usr/bin/env python3
"""Smoke test for Antigravity OAuth automation. Tests accounts one at a time
with delays to avoid Google CAPTCHA rate-limiting.

Usage: .venv/Scripts/python.exe smoke_antigravity.py
"""
import asyncio
import json
import sys
import time

sys.path.insert(0, ".")

from app.providers.antigravity import AntigravityProviderAdapter
from app.providers.base import NormalizedAccount

ACCOUNTS = [
    ("tfatf4@alviwa.com", "qwertyui"),
    ("tfatf5@alviwa.com", "qwertyui"),
]
DELAY_BETWEEN = 0  # seconds — no delay, test rapid-fire


async def test_one(adapter, email, password):
    """Test a single account with hard 60s timeout."""
    account = NormalizedAccount(provider="antigravity", identifier=email, secret=password)
    session = None
    t0 = time.monotonic()
    result = {"email": email, "ok": False, "time_s": 0, "error": None, "tokens": None, "quota": None}
    try:
        async with asyncio.timeout(180):
            session = await adapter.bootstrap_session(account)
            auth_state = await adapter.authenticate(account, session)
            tokens = await adapter.fetch_tokens(account, auth_state, session)
            try:
                quota = await asyncio.wait_for(
                    adapter.fetch_quota(account, tokens, session), timeout=10
                )
            except (asyncio.TimeoutError, Exception) as e:
                quota = None
            result["ok"] = True
            result["tokens"] = {k: v for k, v in tokens.items() if k != "access_token"}
            result["quota"] = quota
    except asyncio.TimeoutError:
        result["error"] = f"hard timeout 180s"
    except Exception as e:
        result["error"] = f"{type(e).__name__}: {e}"
    finally:
        if session:
            try:
                await adapter.cleanup_session(session)
            except Exception:
                pass
    result["time_s"] = round(time.monotonic() - t0, 1)
    return result


async def main():
    adapter = AntigravityProviderAdapter()
    results = []
    for i, (email, password) in enumerate(ACCOUNTS):
        print(f"\n{'='*50}", flush=True)
        print(f"TESTING: {email}", flush=True)
        print(f"{'='*50}", flush=True)
        r = await test_one(adapter, email, password)
        results.append(r)

    print(f"\n{'='*50}", flush=True)
    print("SUMMARY", flush=True)
    print(f"{'='*50}", flush=True)
    for r in results:
        status = "PASS" if r["ok"] else "FAIL"
        print(f"  [{status}] {r['email']} ({r['time_s']}s)", flush=True)
        if r["ok"]:
            t = r["tokens"]
            print(f"        refresh: {t.get('refresh_token', '')[:30]}...", flush=True)
            print(f"        project: {t.get('project_id', '')}", flush=True)
            print(f"        plan:    {t.get('plan_type', '')}", flush=True)
            print(f"        quota:   {json.dumps(r['quota'])}", flush=True)
        else:
            print(f"        error:   {r['error']}", flush=True)

    # Exit code: 0 if all pass, 1 if any fail
    all_ok = all(r["ok"] for r in results)
    sys.exit(0 if all_ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
