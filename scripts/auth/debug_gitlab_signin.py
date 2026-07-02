"""
Standalone debug for GitLab sign-in stage. Runs Camoufox headful, navigates
to /users/sign_in, polls every 1s, AND tries to click the Turnstile checkbox
with humanized mouse movement when detected.

Usage:
    .venv/bin/python debug_gitlab_signin.py
"""
from __future__ import annotations

import asyncio
import os
import random
import sys
import time
from pathlib import Path

from camoufox.async_api import AsyncCamoufox
from browserforge.fingerprints import Screen

DEBUG_DIR = Path("/tmp/duo-debug")
DEBUG_DIR.mkdir(parents=True, exist_ok=True)
SIGN_IN_URL = "https://gitlab.com/users/sign_in"


def log(msg: str) -> None:
    ts = time.strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


async def snap(page, label: str) -> None:
    path = DEBUG_DIR / f"{int(time.time()*1000)}-{label}.png"
    try:
        await page.screenshot(path=str(path), full_page=False)
        log(f"  📸 {path.name}")
    except Exception as e:
        log(f"  ⚠️ screenshot failed: {e}")


async def try_click_turnstile(page) -> bool:
    """Detect Turnstile iframe and click the checkbox with humanized motion.

    Returns True if a click was attempted (success/failure unknown until next poll).
    """
    # Cloudflare Turnstile injects an iframe whose src starts with challenges.cloudflare.com
    iframes = page.frames
    cf_frame = None
    for f in iframes:
        if "challenges.cloudflare.com" in f.url:
            cf_frame = f
            break

    if not cf_frame:
        return False

    log(f"  🔎 Found CF iframe: {cf_frame.url[:80]}")

    # Inside the iframe, the checkbox has label="Verify you are human" or input[type=checkbox]
    try:
        # Try multiple selectors — Cloudflare's DOM varies
        candidates = [
            'input[type="checkbox"]',
            'label.cb-lb input',
            'label input[type="checkbox"]',
            '[role="checkbox"]',
        ]
        checkbox = None
        for sel in candidates:
            loc = cf_frame.locator(sel).first
            try:
                if await loc.count() > 0:
                    checkbox = loc
                    log(f"  ✓ Checkbox found via selector: {sel}")
                    break
            except Exception:
                continue

        if not checkbox:
            log("  ⚠️ Turnstile iframe found but no checkbox selector matched")
            # Fallback: click the iframe element itself at offset
            log("  → trying click on iframe element with offset")
            iframe_el = page.locator('iframe[src*="challenges.cloudflare.com"]').first
            box = await iframe_el.bounding_box()
            if box:
                # Click ~30px from left edge, vertically centered (where checkbox usually is)
                x = box["x"] + 30
                y = box["y"] + box["height"] / 2
                log(f"  → moving mouse to ({x:.0f}, {y:.0f}) with humanize")
                # Move in steps (Camoufox humanize handles smoothing)
                await page.mouse.move(x - 100, y - 50, steps=10)
                await asyncio.sleep(random.uniform(0.3, 0.8))
                await page.mouse.move(x, y, steps=15)
                await asyncio.sleep(random.uniform(0.5, 1.2))
                await page.mouse.click(x, y)
                log("  ✓ clicked iframe at offset")
                return True
            return False

        # Get bounding box and move with humanized path
        box = await checkbox.bounding_box()
        if not box:
            log("  ⚠️ checkbox bounding box not available")
            return False

        target_x = box["x"] + box["width"] / 2 + random.uniform(-3, 3)
        target_y = box["y"] + box["height"] / 2 + random.uniform(-3, 3)

        log(f"  → mouse move to checkbox at ({target_x:.0f}, {target_y:.0f})")

        # Move from current position via 2 intermediate points (Camoufox will smooth)
        start_x = random.uniform(100, 500)
        start_y = random.uniform(100, 400)
        await page.mouse.move(start_x, start_y, steps=8)
        await asyncio.sleep(random.uniform(0.2, 0.5))

        await page.mouse.move(
            (start_x + target_x) / 2 + random.uniform(-50, 50),
            (start_y + target_y) / 2 + random.uniform(-30, 30),
            steps=12,
        )
        await asyncio.sleep(random.uniform(0.3, 0.6))

        await page.mouse.move(target_x, target_y, steps=10)
        await asyncio.sleep(random.uniform(0.4, 0.9))

        await page.mouse.click(target_x, target_y)
        log("  ✓ clicked Turnstile checkbox with humanized motion")
        return True

    except Exception as e:
        log(f"  ❌ click failed: {type(e).__name__}: {e}")
        return False


async def main() -> int:
    proxy = os.getenv("BATCHER_PROXY_URL") or None
    log(f"Proxy: {proxy or '(none)'}")

    manager = AsyncCamoufox(
        headless=False,
        humanize=True,
        os=("windows",),
        screen=Screen(max_width=1920, max_height=1080),
        proxy={"server": proxy} if proxy else None,
        i_know_what_im_doing=True,
    )

    browser = await manager.__aenter__()
    log(f"Camoufox launched.")

    try:
        page = await browser.new_page()

        log(f"→ goto {SIGN_IN_URL}")
        t0 = time.time()
        try:
            response = await page.goto(SIGN_IN_URL, wait_until="domcontentloaded", timeout=60_000)
            log(f"  goto returned in {time.time()-t0:.1f}s, status={response.status if response else 'None'}")
        except Exception as e:
            log(f"  goto FAILED: {type(e).__name__}: {e}")
            return 1

        await snap(page, "after-goto")

        # Wait a bit for Turnstile to render
        await asyncio.sleep(3)

        # Poll loop with click attempts
        deadline = time.time() + 90
        last_url = ""
        last_title = ""
        attempt = 0
        click_attempts = 0
        last_click_time = 0

        while time.time() < deadline:
            attempt += 1
            try:
                url = page.url
                title = await page.title()
                if url != last_url or title != last_title:
                    log(f"[t+{int(time.time()-t0)}s] URL={url} TITLE={title!r}")
                    last_url = url
                    last_title = title

                # Success check
                oauth_count = await page.locator('a[href*="/users/auth/google_oauth2"]').count()
                if oauth_count > 0:
                    visible = await page.locator('a[href*="/users/auth/google_oauth2"]').first.is_visible()
                    if visible:
                        log("✅ SUCCESS: past Cloudflare, Google OAuth visible")
                        await snap(page, "final-success")
                        await asyncio.sleep(3)
                        return 0
                    log(f"  oauth count={oauth_count} but not visible yet")

                # Try to click Turnstile every 8s if still on challenge
                if title.startswith("Just a moment") or "Verify" in title:
                    if time.time() - last_click_time > 8 and click_attempts < 5:
                        click_attempts += 1
                        log(f"--- Turnstile click attempt #{click_attempts} ---")
                        await snap(page, f"before-click-{click_attempts}")
                        clicked = await try_click_turnstile(page)
                        if clicked:
                            last_click_time = time.time()
                            await asyncio.sleep(2)
                            await snap(page, f"after-click-{click_attempts}")

                if attempt in (5, 15, 30, 60):
                    await snap(page, f"poll-{attempt}")

            except Exception as e:
                log(f"  poll error: {type(e).__name__}: {e}")

            await asyncio.sleep(1)

        log("❌ TIMEOUT after 90s")
        await snap(page, "final-timeout")
        try:
            content = await page.content()
            (DEBUG_DIR / "final-html.html").write_text(content[:200_000])
            log(f"  💾 final HTML saved")
        except Exception:
            pass
        return 2

    finally:
        log("Closing browser in 8s...")
        await asyncio.sleep(8)
        try:
            await manager.__aexit__(None, None, None)
        except Exception:
            pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
