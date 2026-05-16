"""One-time interactive login into the persistent Chromium profile.

Run this once per platform you want Pincer to post on:

    uv run python login.py

Two Chromium tabs open: one at reddit.com/login, one at news.ycombinator.com/login.
Log into each like a normal human — type credentials, solve any captcha, click
through MFA. There's no time limit; the browser stays open until you press
Enter in this terminal. The script then closes Chromium cleanly so it flushes
its session to ./profile.

You can also navigate to OTHER platforms (X, instagram.com, discord.com)
inside the same Chromium window and log in there too — Chromium doesn't
isolate cookies by tab, so everything saves to the same profile.

From then on, every sidecar run reuses ./profile and finds itself already
authenticated on every platform you signed into.

We use Playwright (not browser-use) with the *same* stealth knobs as runtime
posting in platforms/*.py. Sharing fingerprint between login and runtime is
important: sites fingerprint the session, and a mismatch between the browser
that logged in and the browser that's posting can re-trigger anti-bot logic
and invalidate the session immediately.
"""

import asyncio
import sys
from pathlib import Path

from playwright.async_api import async_playwright


# Profile lives alongside this script. Use an absolute path so the script
# works regardless of where you invoke it from.
PROFILE_DIR = str(Path(__file__).resolve().parent / "profile")


async def main() -> None:
    print(f"Launching Chromium with persistent profile at {PROFILE_DIR}/")
    print("Two tabs will open: Reddit + Hacker News login.")
    print("Log into each, then return here and press Enter to save + exit cleanly.\n")

    async with async_playwright() as p:
        # Stealth knobs identical to platforms/*.py — see those files for the
        # full rationale. Summary: Reddit's WAF fingerprints Playwright's
        # defaults (navigator.webdriver, --enable-automation) and blocks
        # otherwise. HN doesn't care as much, but we standardize for
        # consistency between login and runtime.
        ctx = await p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=False,
            ignore_default_args=["--enable-automation"],
            args=["--disable-blink-features=AutomationControlled"],
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        try:
            # Open one tab per platform so the user can log into all of them
            # in a single session. Cookies for every site visited in this
            # Chromium save to the same ./profile directory.
            reddit_page = await ctx.new_page()
            await reddit_page.goto("https://www.reddit.com/login")

            hn_page = await ctx.new_page()
            await hn_page.goto("https://news.ycombinator.com/login")

            # Block on stdin without freezing the event loop. Playwright's
            # context stays open as long as we don't call ctx.close(), so
            # there's no time limit on how long you can spend logging in.
            await asyncio.to_thread(
                input,
                "→ Log in to each tab, then press Enter here to save + exit: ",
            )
        finally:
            # Close cleanly so Chromium flushes cookies/localStorage to
            # ./profile/ before the process exits.
            print("Closing Chromium and flushing profile...")
            await ctx.close()
            print(f"Done. Profile saved to {PROFILE_DIR}/")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nAborted before profile was saved cleanly.", file=sys.stderr)
        sys.exit(1)
