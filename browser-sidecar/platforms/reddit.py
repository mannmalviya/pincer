"""Deterministic Reddit posting via Playwright against www.reddit.com (new UI).

The new reddit submit page renders its form inside an <r-post-composer-form>
custom element with an OPEN shadow root. Playwright's accessibility-aware
locators (get_by_role) automatically pierce open shadow roots — meaning we
can address title/body/submit by their ARIA role+name without writing any
querySelector JS plumbing. This is the same mechanism a screen reader uses
to navigate the page, so it's also the most semantically-stable selector.

Why deterministic instead of LLM-driven:
    We previously tried browser-use's Agent loop with Nemotron Super 120B and
    Nano-Omni vision — Super was minutes-slow, Nano hallucinated visual state
    and looped indefinitely on this same submit page. For platforms with stable
    accessible markup, scripted automation is ~10x faster and 100% reproducible.

Authentication:
    We rely on the persistent Chromium profile at ./profile/ (populated once
    via login.py). Cookies inside that directory are picked up by Playwright's
    launch_persistent_context — no login flow at runtime.

Anti-bot:
    Reddit's WAF fingerprints Playwright's defaults (navigator.webdriver,
    --enable-automation flag) and blocks instantly. We patch both via launch
    args and an init script that runs before site JS gets to read the property.
"""

from __future__ import annotations

import re
from pathlib import Path

from playwright.async_api import async_playwright

from . import clear_stale_singleton


# Profile directory lives at browser-sidecar/profile/, one level up from this
# file. Compute the absolute path so we don't depend on CWD when uvicorn is
# launched from elsewhere.
PROFILE_DIR = str(Path(__file__).resolve().parent.parent / "profile")


async def post_to_reddit(subreddit: str, title: str, body: str) -> str:
    """Submit a self-text post to /r/<subreddit> and return its permalink URL.

    Raises Playwright's TimeoutError if Reddit doesn't redirect us to a
    success URL within 30s of clicking submit. That usually means a captcha,
    shadowban, or approval-required subreddit. Let the caller surface it.

    Args:
        subreddit: e.g. "test", "SideProject" (no leading "r/").
        title: post title (Reddit's hard limit is 300 chars).
        body: self-text body (Reddit's hard limit is 40,000 chars).

    Returns:
        Canonical permalink of the created post, e.g.
        "https://www.reddit.com/comments/1abc23". Reddit's /comments/<id>
        short form redirects to the full slugged URL when followed.
    """
    # ?type=TEXT preselects the text-post mode so we skip the link/text tab
    # toggle and land directly on the right form fields.
    submit_url = f"https://www.reddit.com/r/{subreddit}/submit/?type=TEXT"

    # Sweep stale Singleton* lock files if the previous Chromium owner is
    # dead. Without this, launch_persistent_context tries to forward to a
    # nonexistent "existing browser session" and immediately fails with
    # TargetClosedError.
    clear_stale_singleton(PROFILE_DIR)

    async with async_playwright() as p:
        # launch_persistent_context() is the Playwright equivalent of
        # `chrome --user-data-dir=...`. It launches Chromium with our saved
        # cookies/localStorage in place, so we boot already-logged-in.
        # headless=False during dev so we can visually confirm the post
        # actually appears. Flip to True once this is bulletproof.
        #
        # Stealth knobs:
        #   - ignore_default_args removes Playwright's --enable-automation flag
        #     that flips a bunch of webdriver-related properties to true.
        #   - --disable-blink-features=AutomationControlled is the canonical
        #     "make navigator.webdriver undefined" Chrome flag.
        ctx = await p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=False,
            ignore_default_args=["--enable-automation"],
            args=["--disable-blink-features=AutomationControlled"],
        )

        # Belt-and-suspenders: run a script in every new page BEFORE any site
        # JS executes, redefining navigator.webdriver to return undefined.
        # The Chrome flag above usually handles this but some bot-detection
        # libraries probe the property descriptor directly.
        await ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        try:
            page = await ctx.new_page()
            # domcontentloaded is enough — we have explicit waits below for the
            # specific elements we need, no value in waiting for every analytics
            # pixel to settle.
            await page.goto(submit_url, wait_until="domcontentloaded")

            # Title and Post button: accessibility-role locators work
            # fine for these (the title is a native <textarea name="title">
            # and the post button is a plain <button>). The body is the
            # tricky one — see below.
            title_field = page.get_by_role("textbox", name="Title")
            post_button = page.get_by_role("button", name="Post")

            # Wait for the composer to hydrate. The page may have loaded but
            # the shadow DOM contents render asynchronously after client-side
            # hydration. We probe the title field as a proxy for "form is ready".
            await title_field.wait_for(state="visible", timeout=15_000)

            # Drive the body composer via its Lit attributes/properties
            # rather than the UI. Reddit's <shreddit-composer> is a Lit
            # component with an observed `mode` attribute and a reactive
            # `value` property, so we can flip modes and set the body
            # programmatically without clicking through any toolbar.
            #
            # Why not click the "Switch to Markdown" toggle: Reddit
            # recently moved it behind the toolbar's "More options"
            # overflow menu, and the surfaced rpl-menu-item swallows
            # programmatic clicks (mouse-coordinate, locator.click,
            # keyboard Enter) without firing its handler. Driving the
            # composer directly bypasses the menu, the confirmation
            # modal, and the toolbar entirely.
            #
            # Why mode via attribute but value via property: the `value`
            # attribute on shreddit-composer is the rich-text JSON
            # document (`{"document":[...]}`), not plain text. Setting
            # `setAttribute('value', '**bold**')` is silently ignored
            # because that string isn't valid rich-text JSON. The Lit
            # property setter (`c.value = '**bold**'`), in markdown
            # mode, accepts a raw markdown string and writes it to the
            # composer's internal store.
            await page.evaluate(
                """() => {
                  const c = document.querySelector(
                      'shreddit-composer#post-composer_bodytext');
                  if (!c) throw new Error('shreddit-composer#post-composer_bodytext not found');
                  c.setAttribute('mode', 'markdown');
                }"""
            )

            # Wait for the mode flip to settle before writing the value.
            # The composer rebuilds its internal state on mode change,
            # so setting `value` before the markdown branch has rendered
            # gets clobbered when the rebuild completes.
            await page.wait_for_function(
                """() => {
                  const c = document.querySelector(
                      'shreddit-composer#post-composer_bodytext');
                  return c
                      && c.getAttribute('mode') === 'markdown'
                      && (c.value || '') === '';
                }""",
                timeout=5_000,
            )

            await page.evaluate(
                """(body) => {
                  const c = document.querySelector(
                      'shreddit-composer#post-composer_bodytext');
                  c.value = body;
                }""",
                body,
            )

            # Verify the value landed. If `c.value` is still empty after
            # 5s, the markdown property setter rejected the assignment
            # (e.g. mode flip didn't fully settle, or Reddit changed the
            # composer's API). Bail loudly rather than submit an empty
            # body.
            await page.wait_for_function(
                """() => {
                  const c = document.querySelector(
                      'shreddit-composer#post-composer_bodytext');
                  return c
                      && c.getAttribute('mode') === 'markdown'
                      && (c.value || '').length > 0;
                }""",
                timeout=5_000,
            )

            await title_field.fill(title)

            # Click submit, then wait for the success URL. Reddit's new
            # composer fires TWO redirects after a successful post:
            #   1. /r/<sub>/?created=t3_<id>&createdPostType=text&...
            #   2. /r/<sub>/                       (query params cleared)
            # The post ID lives in the first one's `created` param. The
            # OLD flow used to land directly on /r/<sub>/comments/<id>/<slug>/,
            # so we accept either shape. wait_for_url uses framenavigated
            # events instead of bracketing a single navigation, so it
            # tolerates the two-step redirect without racing on the load
            # event of the second nav (which is what tripped expect_navigation).
            await post_button.click()
            await page.wait_for_url(
                re.compile(r"/comments/|created=t3_"),
                timeout=30_000,
                wait_until="domcontentloaded",
            )

            # If we caught the `?created=t3_<id>` form, lift the post ID
            # and return the canonical short permalink. Reddit's
            # /comments/<id> URL 301-redirects to the full slugged form
            # when opened in a browser, so the dashboard's "View post"
            # link still lands where the user expects.
            match = re.search(r"[?&]created=t3_([a-z0-9]+)", page.url)
            if match:
                return f"https://www.reddit.com/comments/{match.group(1)}"

            # Old-style /comments/<id>/<slug>/ landing — already a permalink.
            return page.url
        finally:
            # Close cleanly so Chromium flushes any updated cookies (e.g. a
            # rotated session token) back to the profile directory before
            # the process exits.
            await ctx.close()
