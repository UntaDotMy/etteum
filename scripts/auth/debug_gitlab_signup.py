"""Test if /users/sign_up bypasses Cloudflare in Camoufox."""
from __future__ import annotations
import asyncio, os, sys, time
from pathlib import Path
from camoufox.async_api import AsyncCamoufox
from browserforge.fingerprints import Screen

DEBUG_DIR = Path("/tmp/duo-debug")
DEBUG_DIR.mkdir(parents=True, exist_ok=True)
SIGN_UP_URL = "https://gitlab.com/users/sign_up"


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)
async def snap(p, l):
    path = DEBUG_DIR / f"signup-{int(time.time()*1000)}-{l}.png"
    try: await p.screenshot(path=str(path)); log(f"  📸 {path.name}")
    except Exception as e: log(f"  ⚠️ {e}")


async def main():
    proxy = os.getenv("BATCHER_PROXY_URL") or None
    log(f"Proxy: {proxy or '(none)'}")
    manager = AsyncCamoufox(
        headless=False, humanize=True, os=("windows",),
        screen=Screen(max_width=1920, max_height=1080),
        proxy={"server": proxy} if proxy else None,
        i_know_what_im_doing=True,
    )
    browser = await manager.__aenter__()
    try:
        page = await browser.new_page()
        log(f"→ goto {SIGN_UP_URL}")
        t0 = time.time()
        resp = await page.goto(SIGN_UP_URL, wait_until="domcontentloaded", timeout=60_000)
        log(f"  goto returned in {time.time()-t0:.1f}s, status={resp.status if resp else 'None'}")
        await asyncio.sleep(2)
        title = await page.title()
        url = page.url
        log(f"  URL={url}")
        log(f"  TITLE={title!r}")
        await snap(page, "after-goto")

        # Check for sign-up form Google button
        google_btn_count = await page.locator('button[data-provider="google_oauth2"], form[action*="google_oauth2"] button').count()
        log(f"  Google button count: {google_btn_count}")

        if google_btn_count > 0:
            visible = await page.locator('button[data-provider="google_oauth2"], form[action*="google_oauth2"] button').first.is_visible()
            log(f"  Google button visible: {visible}")
            if visible:
                log("✅ SIGN_UP BYPASSES CLOUDFLARE")
                await snap(page, "google-btn-visible")

                # Now try clicking and see what happens
                log("→ Clicking Google button to test full flow...")
                await page.locator('button[data-provider="google_oauth2"], form[action*="google_oauth2"] button').first.click()
                await asyncio.sleep(3)
                log(f"  After click URL={page.url}")
                log(f"  After click TITLE={await page.title()!r}")
                await snap(page, "after-google-click")

                # Wait for navigation to Google
                try:
                    await page.wait_for_url("**accounts.google.com**", timeout=15000)
                    log("✅ Reached Google OAuth page!")
                    await snap(page, "google-oauth-page")
                except Exception as e:
                    log(f"  ⚠️ did not reach google: {e}")
                    log(f"  current URL: {page.url}")

                await asyncio.sleep(20)  # Let user inspect
                return 0
        else:
            log("❌ No Google button found on sign_up")
            html = await page.content()
            (DEBUG_DIR / "signup-html.html").write_text(html[:200_000])

        # Check if CF challenge
        if "Just a moment" in title or "Verify" in title:
            log("❌ Cloudflare on sign_up too")
            return 2

        log("Unexpected state, sleeping 20s for inspection")
        await asyncio.sleep(20)
        return 1
    finally:
        try: await manager.__aexit__(None, None, None)
        except Exception: pass


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
