"""Inspect the GitLab welcome form HTML structure to find the right
selectors for the role/objective dropdowns. Reuses the existing logged-in
session from a manual run.

Usage:
    .venv/bin/python debug_welcome_form.py <email> <password>
"""
from __future__ import annotations
import asyncio, os, sys, time
from pathlib import Path
from camoufox.async_api import AsyncCamoufox
from browserforge.fingerprints import Screen

DEBUG_DIR = Path("/tmp/duo-debug")
DEBUG_DIR.mkdir(parents=True, exist_ok=True)


def log(m): print(f"[{time.strftime('%H:%M:%S')}] {m}", flush=True)


async def main(email, password):
    proxy = os.getenv("BATCHER_PROXY_URL") or None
    manager = AsyncCamoufox(
        headless=False, humanize=True, os=("windows",),
        screen=Screen(max_width=1920, max_height=1080),
        proxy={"server": proxy} if proxy else None,
        i_know_what_im_doing=True,
    )
    browser = await manager.__aenter__()
    try:
        page = await browser.new_page()

        # Step 1: get to the welcome form. We assume the user has already
        # gone through Google login once in this profile, so re-login is
        # quick. Otherwise, run the full bot first then this script.
        await page.goto("https://gitlab.com/users/sign_up", wait_until="domcontentloaded")
        await asyncio.sleep(3)

        # Try Google button
        try:
            await page.locator('button[data-provider="google_oauth2"]').first.click(no_wait_after=True)
            log("clicked Google")
        except Exception as e:
            log(f"google click failed: {e}")
            await asyncio.sleep(60)
            return

        # Wait for return to gitlab
        for _ in range(60):
            await asyncio.sleep(1)
            url = page.url
            if "gitlab.com" in url and "google" not in url:
                log(f"back to gitlab: {url}")
                break

        # If we're at welcome, dump the HTML
        for _ in range(15):
            url = page.url
            if "/users/sign_up/welcome" in url:
                log(f"AT WELCOME FORM: {url}")
                break
            log(f"waiting for welcome... current: {url}")
            await asyncio.sleep(2)
        else:
            log(f"never reached welcome, current: {page.url}")
            await asyncio.sleep(60)
            return

        await asyncio.sleep(3)

        # Dump form structure
        try:
            form_html = await page.locator('form').first.inner_html()
            (DEBUG_DIR / "welcome-form.html").write_text(form_html)
            log(f"saved welcome-form.html ({len(form_html)} chars)")
        except Exception as e:
            log(f"form dump failed: {e}")

        # List all interactive elements
        try:
            elements = await page.evaluate("""() => {
                const out = [];
                const selectors = [
                    'select', 'input', 'button', '[role="button"]',
                    '[role="combobox"]', '[role="listbox"]',
                    '[aria-haspopup]', 'div[tabindex]',
                    '.gl-dropdown', '.dropdown-toggle',
                ];
                const seen = new Set();
                for (const sel of selectors) {
                    for (const el of document.querySelectorAll(sel)) {
                        if (seen.has(el)) continue;
                        seen.add(el);
                        if (el.offsetParent === null) continue;
                        const tag = el.tagName.toLowerCase();
                        const id = el.id ? `#${el.id}` : '';
                        const cls = el.className ? `.${String(el.className).split(' ').filter(Boolean).slice(0,3).join('.')}` : '';
                        const role = el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : '';
                        const haspopup = el.getAttribute('aria-haspopup') ? `[aria-haspopup=${el.getAttribute('aria-haspopup')}]` : '';
                        const dtid = el.getAttribute('data-testid') ? `[testid=${el.getAttribute('data-testid')}]` : '';
                        const aria = el.getAttribute('aria-label') ? `[label="${el.getAttribute('aria-label').slice(0,30)}"]` : '';
                        const txt = (el.textContent || '').trim().slice(0, 50);
                        out.push(`${tag}${id}${cls}${role}${haspopup}${dtid}${aria} text="${txt}"`);
                    }
                }
                return out;
            }""")
            log(f"=== INTERACTIVE ELEMENTS ({len(elements)}) ===")
            for el in elements:
                log(f"  {el}")
        except Exception as e:
            log(f"element dump failed: {e}")

        log("Sleeping 60s for inspection...")
        await asyncio.sleep(60)
        return 0

    finally:
        try: await manager.__aexit__(None, None, None)
        except Exception: pass


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: debug_welcome_form.py <email> <password>")
        sys.exit(1)
    sys.exit(asyncio.run(main(sys.argv[1], sys.argv[2])))
