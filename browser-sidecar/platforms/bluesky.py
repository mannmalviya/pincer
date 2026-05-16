"""Deterministic Bluesky posting via Playwright against bsky.app.

Bluesky's web client is a React SPA backed by the AT Protocol. We could call
com.atproto.repo.createRecord directly with the stored JWT, but the user's
session JWT lives in localStorage (not a cookie), so reusing it from a
fresh Python HTTP client is painful. Driving the real browser is simpler
and keeps the auth shape identical to the login flow that populated the
profile.

Capturing the new post's permalink:
    Two-track approach because the createRecord XHR is unreliable to
    intercept — Bluesky may route writes through the user's own PDS
    (different host), batch them via applyWrites, or stage them through
    a service worker. We:
      1. Subscribe to every response with `page.on("response")` and grab
         the first AT URI we see in a JSON body that looks like a post.
         Best case: this fires within ~1s of clicking publish.
      2. Independently wait for the composer modal to close, which is
         Bluesky's UI signal that the post was accepted.
      3. If (1) gave us a URI we're done. Otherwise we fall back to
         scraping the user's own profile feed for the most recent post
         link — Bluesky redirects /profile/me to the signed-in user's
         handle, and the first post-link in the timeline is the one we
         just published.

Selectors:
    The composer uses data-testid attributes that have been stable for
    a while (composeFAB, composerTextInput, composerPublishBtn). We
    prefer those over visible text since Bluesky localizes the button
    copy per browser language.
"""

from __future__ import annotations

import re
from pathlib import Path

from playwright.async_api import Response, async_playwright

from . import clear_stale_singleton


# AT URI for a post record: at://<did>/app.bsky.feed.post/<rkey>.
# Used both to recognize the response payload from createRecord and to
# pull URIs out of profile-page HTML as the fallback.
_POST_URI_RE = re.compile(
    r"at://(did:[a-z0-9:]+)/app\.bsky\.feed\.post/([A-Za-z0-9]+)"
)


# Profile directory lives one level up from this file, shared with every
# other platform's persistent_context so the Bluesky session cookies +
# localStorage saved during /login/finish are available at post time.
PROFILE_DIR = str(Path(__file__).resolve().parent.parent / "profile")

# Bluesky enforces a 300-character cap server-side. We mirror it here so
# a too-long draft fails with a clear message instead of a generic
# Playwright timeout when the Post button stays disabled.
BLUESKY_MAX_CHARS = 300


async def post_to_bluesky(text: str) -> str:
    """Submit a top-level Bluesky post and return its bsky.app permalink.

    Args:
        text: full post body (Bluesky has no title field). Cap of 300
            characters; longer drafts raise ValueError up front.

    Returns:
        Canonical permalink, e.g.
        "https://bsky.app/profile/did:plc:abc.../post/3kabcxyz".

    Raises:
        ValueError: if `text` is empty or exceeds 300 characters.
        RuntimeError: if the createRecord XHR fires but its response can't
            be parsed (Bluesky changed the response shape).
        Playwright TimeoutError: if the composer never opens or the
            submit never lands an XHR response (auth gone, captcha, etc.).
    """
    text = text.strip()
    if not text:
        raise ValueError("Bluesky posts require non-empty text")
    if len(text) > BLUESKY_MAX_CHARS:
        raise ValueError(
            f"Bluesky posts cap at {BLUESKY_MAX_CHARS} characters (got {len(text)})"
        )

    # Sweep stale Singleton* lock files if the previous Chromium owner is
    # dead. Same dance every other platform handler does.
    clear_stale_singleton(PROFILE_DIR)

    async with async_playwright() as p:
        ctx = await p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=False,
            # Same stealth knobs as the other handlers — Bluesky doesn't
            # fingerprint heavily today, but consistency means one less
            # variable when debugging.
            ignore_default_args=["--enable-automation"],
            args=["--disable-blink-features=AutomationControlled"],
        )
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        try:
            page = await ctx.new_page()
            await page.goto("https://bsky.app/", wait_until="domcontentloaded")

            # Open the composer. The floating "New post" FAB is the most
            # stable entrypoint; the same button is also available from
            # the left nav as "New post" but the FAB is consistent across
            # both mobile- and desktop-width layouts.
            compose_fab = page.locator(
                '[data-testid="composeFAB"], [aria-label="New post"]'
            ).first
            await compose_fab.wait_for(state="visible", timeout=15_000)
            await compose_fab.click()

            # Composer is a modal with a contenteditable rich-text input.
            # data-testid="composerTextInput" has been stable; we fall back
            # to role=textbox in case Bluesky renames it.
            editor = page.locator(
                '[data-testid="composerTextInput"], [role="textbox"]'
            ).first
            await editor.wait_for(state="visible", timeout=10_000)
            # The composer is a Lexical/ProseMirror-style editor — `fill`
            # would no-op on a contenteditable. `type` issues real keystrokes
            # which the editor's input handler picks up cleanly.
            await editor.click()
            await page.keyboard.type(text)

            publish_btn = page.locator(
                '[data-testid="composerPublishBtn"]'
            ).first
            await publish_btn.wait_for(state="visible", timeout=10_000)

            # Track #1: snoop every response that crosses the page and
            # remember the first AT URI we see for a post record. The
            # write may go to bsky.social, a custom PDS, or be batched
            # through applyWrites — matching the URL substring is too
            # brittle, so we sniff the response body instead. Cheap
            # because Bluesky's responses are small JSON blobs.
            captured: dict[str, str] = {}

            async def on_response(resp: Response) -> None:
                # Ignore everything except XRPC traffic. Bluesky proxies
                # writes through /xrpc/* on whatever host the user's
                # repo lives on. This filter keeps us from parsing
                # tracking pixels and image responses.
                if "/xrpc/" not in resp.url:
                    return
                if captured:
                    return
                try:
                    text = await resp.text()
                except Exception:
                    return
                m = _POST_URI_RE.search(text)
                if not m:
                    return
                captured["did"] = m.group(1)
                captured["rkey"] = m.group(2)

            page.on("response", on_response)

            try:
                await publish_btn.click()

                # Track #2: the composer dialog disappearing is Bluesky's
                # UI confirmation that the post was accepted. This is the
                # reliable success signal — if the composer stays open the
                # post was rejected (validation error, network failure,
                # session expired). 30s is generous; a healthy post lands
                # in <2s.
                try:
                    await page.locator(
                        '[data-testid="composerTextInput"]'
                    ).first.wait_for(state="hidden", timeout=30_000)
                except Exception:
                    # Composer is still open after 30s. The post almost
                    # certainly failed; surface any visible error from the
                    # composer itself so the caller has something useful.
                    err_text = ""
                    try:
                        err_text = (
                            await page.locator('[role="alert"]').first.text_content(
                                timeout=1_000
                            )
                            or ""
                        )
                    except Exception:
                        pass
                    raise RuntimeError(
                        "Bluesky composer stayed open after publish click "
                        f"(likely failure): {err_text or 'no error message visible'}"
                    )

                # If the response sniffer caught the URI we're done.
                if captured:
                    return (
                        f"https://bsky.app/profile/{captured['did']}"
                        f"/post/{captured['rkey']}"
                    )

                # Fallback: the post landed (modal closed) but we missed
                # the response. Read the URI off the user's own profile
                # feed. /profile/me redirects to the signed-in user's
                # handle, and the topmost post link is the one we just
                # published. We pull the AT URI out of the embedded
                # state JSON when possible (stable), then fall back to
                # scraping the visible permalink anchors.
                await page.goto(
                    "https://bsky.app/profile/me",
                    wait_until="domcontentloaded",
                )

                # Read every /profile/<handle>/post/<rkey> anchor and
                # take the first. The signed-in user's feed is sorted
                # newest-first, so the first link is our post. Wait up
                # to 15s for the timeline to hydrate.
                handle_post_re = re.compile(
                    r"^/profile/([^/]+)/post/([A-Za-z0-9]+)$"
                )
                first_post: dict[str, str] = {}

                async def try_scrape() -> bool:
                    hrefs = await page.evaluate(
                        """() => Array.from(
                              document.querySelectorAll('a[href*="/post/"]')
                          ).map(a => a.getAttribute('href') || '')"""
                    )
                    for href in hrefs:
                        m = handle_post_re.match(href)
                        if m:
                            first_post["handle"] = m.group(1)
                            first_post["rkey"] = m.group(2)
                            return True
                    return False

                # Poll the DOM rather than chaining wait_for_selector +
                # text reads — we need the href attribute and Bluesky's
                # post anchors don't have a stable data-testid we can
                # latch onto.
                for _ in range(30):  # ~15s at 500ms cadence
                    if await try_scrape():
                        break
                    await page.wait_for_timeout(500)

                if not first_post:
                    raise RuntimeError(
                        "Bluesky post succeeded but could not locate the "
                        "resulting URL on the user's profile feed."
                    )

                return (
                    f"https://bsky.app/profile/{first_post['handle']}"
                    f"/post/{first_post['rkey']}"
                )
            finally:
                # Detach the response listener so it can't fire against
                # a closed page during shutdown.
                page.remove_listener("response", on_response)
        finally:
            # Flush any rotated session JWTs back to the profile dir.
            await ctx.close()
