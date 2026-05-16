"""Deterministic Hacker News posting via Playwright.

HN is the simplest posting target on the internet — a single HTML form that
hasn't changed since 2007. No React, no shadow DOM, no aggressive bot
fingerprinting. Selectors are bulletproof:
    input[name='title']    — story title (max ~80 chars)
    input[name='url']      — outbound link (for link submissions)
    textarea[name='text']  — body text (for Show HN / Ask HN / discussion)
    input[type='submit']   — the submit button

Caveats:
    - Very new accounts may have submission disabled until they earn a few
      karma points by commenting. If posting silently fails, check that
      login.py logged in successfully and the account is allowed to post.
    - HN aggressively shadow-bans submissions that look promotional. A
      "successful" submit can still be invisible to other users. Verify
      by viewing the URL while logged out.
"""

from __future__ import annotations

import re
from pathlib import Path

from playwright.async_api import TimeoutError as PlaywrightTimeoutError, async_playwright

from . import clear_stale_singleton


# Substrings HN renders on its various "we won't let you post right now"
# pages. Matching is case-insensitive so we don't have to chase exact
# capitalization between page variants. Conservative list: anything that
# clearly identifies the response as a rate-limit / throttle, not as a
# generic landing page.
HN_RATE_LIMIT_MARKERS = (
    "posting too fast",
    "submitting too fast",
    "please slow down",
    "you're posting too fast",
    "you're submitting too fast",
)


# Profile directory lives at browser-sidecar/profile/, one level up from this
# file. Absolute path so the script works regardless of CWD.
PROFILE_DIR = str(Path(__file__).resolve().parent.parent / "profile")


async def post_to_hn(
    title: str,
    text: str | None = None,
    url: str | None = None,
) -> str:
    """Submit a Hacker News story and return its item permalink.

    Exactly one of `text` or `url` must be provided:
        - `text` only → self-post (Show HN, Ask HN, or general discussion)
        - `url` only → link submission

    Args:
        title: story title (HN's form enforces ~80 char limit).
        text: optional self-text body; mutually exclusive with `url`.
        url: optional outbound link; mutually exclusive with `text`.

    Returns:
        Permalink URL, e.g. "https://news.ycombinator.com/item?id=12345678".

    Raises:
        ValueError: if neither or both of text/url were given.
        Playwright TimeoutError: if HN doesn't redirect after submit (rate
            limit, captcha, account not authorized).
    """
    if (text is None) == (url is None):
        raise ValueError("Provide exactly one of `text` or `url`")

    # Sweep stale Singleton* lock files if the previous Chromium owner is
    # dead. See platforms/__init__.py::clear_stale_singleton for the why.
    clear_stale_singleton(PROFILE_DIR)

    async with async_playwright() as p:
        # Stealth knobs identical to platforms/reddit.py — the sidecar
        # standardizes on these so login and runtime share a fingerprint.
        # HN doesn't fingerprint nearly as hard as Reddit, but consistency
        # means we have one less variable when something breaks.
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
            page = await ctx.new_page()
            await page.goto(
                "https://news.ycombinator.com/submit",
                wait_until="domcontentloaded",
            )

            # If cookies are invalid, HN bounces /submit to /login. Title
            # field won't exist and this raises TimeoutError, which the caller
            # surfaces as a clear "not authenticated" error.
            await page.wait_for_selector("input[name='title']", timeout=10_000)

            await page.fill("input[name='title']", title)
            if url is not None:
                await page.fill("input[name='url']", url)
            else:
                # type-checker: text is guaranteed non-None by the XOR check above
                await page.fill("textarea[name='text']", text or "")

            # Successful submit redirects to /newest (sometimes /front, or
            # straight to /item?id=...). The permissive regex catches all
            # success landings; a failed submit stays on /submit (or a
            # rate-limit page) and this wait times out — we then sniff
            # the current page body for known throttle markers so the
            # caller gets a clean message instead of "navigation timeout".
            try:
                async with page.expect_navigation(
                    url=re.compile(
                        r"news\.ycombinator\.com/(newest|front|news|item)"
                    ),
                    timeout=30_000,
                ):
                    await page.click("input[type='submit']")
            except PlaywrightTimeoutError:
                body_text = (await page.text_content("body") or "").lower()
                if any(m in body_text for m in HN_RATE_LIMIT_MARKERS):
                    raise RuntimeError(
                        "HN rate-limited the submission. Wait a few minutes "
                        "before posting again."
                    )
                if "validation required" in body_text:
                    raise RuntimeError(
                        "HN is asking for captcha/validation. Open "
                        "news.ycombinator.com and submit one post manually "
                        "to clear the challenge."
                    )
                # Unknown failure — surface the original timeout so we can
                # debug from the call log instead of swallowing it.
                raise

            # Best case: HN sent us directly to the item page.
            m = re.search(r"item\?id=(\d+)", page.url)
            if m:
                return f"https://news.ycombinator.com/item?id={m.group(1)}"

            # Otherwise we landed on /newest (or /front). Our submission is
            # the topmost <tr class="athing">; its `id` attribute IS the item
            # ID — much cleaner than scraping titles.
            # Race risk: if another user submitted between our submit and
            # the redirect, we'd grab their item. Acceptable for HN's typical
            # submission rate (~1-10/min) and ignorable for a hackathon demo.
            first_item = page.locator("tr.athing").first
            item_id = await first_item.get_attribute("id")
            if not item_id:
                raise RuntimeError(
                    "HN submit succeeded but could not extract item ID from /newest"
                )

            return f"https://news.ycombinator.com/item?id={item_id}"
        finally:
            await ctx.close()
