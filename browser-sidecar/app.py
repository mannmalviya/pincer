"""Browser sidecar — FastAPI service exposing deterministic platform automations.

Architecture (Plan B):
    Pincer Dashboard / Node Agent ─HTTP─► this sidecar (localhost)
                                          │
                                          ▼
                                     platforms/<name>.py
                                          │  (hand-written Playwright flow)
                                          ▼
                                     local Chromium (persistent profile)

Endpoints:
    GET  /health         — liveness probe
    POST /post           — submit a post on a named platform
    POST /login/start    — open Chromium with login tabs for the given platforms
    POST /login/finish   — close Chromium and flush the profile to disk

Why no LLM in this layer:
    We previously had browser-use's Agent loop here with Nemotron as the brain.
    It was slow (Super 120B: minutes per post) and unreliable (Nano-Omni: looped
    on visual hallucinations). For *known* platforms with stable UIs, scripted
    automation is dramatically faster and 100% reproducible. The LLM still owns
    drafting and classification — that happens upstream in the Node agent, which
    talks to NIM directly. By the time we get called, content is final.

Run for dev:
    uv run uvicorn app:app --port 9000

Smoke test:
    curl -s -X POST http://localhost:9000/post \\
      -H 'content-type: application/json' \\
      -d '{"platform": "reddit", "subreddit": "test", "title": "hello", "body": "world"}'
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from playwright.async_api import BrowserContext, Playwright, async_playwright
from pydantic import BaseModel

from platforms import clear_stale_singleton
from platforms.hackernews import post_to_hn
from platforms.reddit import post_to_reddit

logging.basicConfig(level=logging.INFO)
log = logging.getLogger("pincer.sidecar")


# ---------------------------------------------------------------------------
# Paths and per-platform login URLs
#
# PROFILE_DIR is the persistent Chromium profile every platform shares —
# cookies and localStorage from each site live here, and every subsequent
# /post call reuses them. Login flows write to it; post flows read from it.
#
# LOGIN_URLS is the explicit list of "where do we send the user to log in"
# per platform. We open one tab per platform during /login/start, so the
# user can log into all of them in a single Chromium session.
# ---------------------------------------------------------------------------
PROFILE_DIR = str(Path(__file__).resolve().parent / "profile")

LOGIN_URLS: dict[str, str] = {
    "reddit": "https://www.reddit.com/login",
    "hn": "https://news.ycombinator.com/login",
    "discord": "https://discord.com/login",
    "x": "https://x.com/i/flow/login",
    "instagram": "https://www.instagram.com/accounts/login/",
    "tiktok": "https://www.tiktok.com/login",
}


# ---------------------------------------------------------------------------
# Per-platform login detection.
#
# Used by /login/status to figure out whether the user has successfully
# signed in to each tab. Two layers per platform:
#
#   1. Cookie check (fast, free) — does the live BrowserContext have a
#      non-empty auth cookie on this platform's domain? Catches the common
#      case where the platform sets a session cookie at sign-in. No
#      network calls, so we can poll aggressively.
#
#   2. URL fallback (slower) — fetch a logged-in-only endpoint with the
#      context's APIRequestContext (shares cookies with the visible tabs)
#      and look for a marker string in the response body. Catches platforms
#      whose auth cookie has a different name than we expect, or whose
#      cookies arrive in a different order than the page render.
#
# Discord doesn't fit either pattern — it ships its auth token only in
# memory (no cookie, localStorage gets wiped) — so it's special-cased in
# /login/status: we look for any open tab that has navigated past /login
# to /channels/*, which only happens for signed-in users.
#
# `verify_logged_in_marker` is a substring we expect in the URL fallback
# response when the user is logged in. Status codes alone don't work for
# every platform (Reddit returns 200 + `{}` when logged out, for example),
# so we sniff the body too.
# ---------------------------------------------------------------------------
LOGIN_DETECT: dict[str, dict[str, str]] = {
    "reddit": {
        "cookie_domain": ".reddit.com",
        "cookie_name": "reddit_session",
        "verify_url": "https://www.reddit.com/api/v1/me.json",
        # Logged-in body contains `"name":"<username>"`. Logged-out is `{}`.
        "verify_logged_in_marker": '"name"',
    },
    "hn": {
        "cookie_domain": "news.ycombinator.com",
        "cookie_name": "user",
        "verify_url": "https://news.ycombinator.com/news",
        # HN renders a `logout` link in the top bar when signed in.
        "verify_logged_in_marker": "logout",
    },
    "x": {
        "cookie_domain": ".x.com",
        "cookie_name": "auth_token",
        # X's verify endpoint requires a bearer token; the simplest free
        # signal is the cookie. URL fallback is a tab-based redirect check.
        "verify_url": "https://x.com/home",
        "verify_logged_in_marker": "data-testid=\"primaryColumn\"",
    },
    "instagram": {
        "cookie_domain": ".instagram.com",
        "cookie_name": "sessionid",
        "verify_url": "https://www.instagram.com/accounts/edit/",
        # Logged-out hits redirect to /accounts/login/.
        "verify_logged_in_marker": "Edit profile",
    },
    "tiktok": {
        "cookie_domain": ".tiktok.com",
        "cookie_name": "sessionid",
        "verify_url": "https://www.tiktok.com/api/user/detail/?aid=1988",
        "verify_logged_in_marker": "uniqueId",
    },
    # discord — see _detect_discord_login() below.
}


# ---------------------------------------------------------------------------
# In-flight login session state
#
# Only one login session can run at a time — concurrent logins on the same
# profile dir would race on Chromium's SingletonLock file and corrupt the
# cookies database. We hold the Playwright instance + BrowserContext at
# module scope between /login/start and /login/finish so the Chromium window
# stays open across HTTP requests.
# ---------------------------------------------------------------------------
_login_playwright: Playwright | None = None
_login_ctx: BrowserContext | None = None

# Serializes /post calls. Every platform handler launches its own
# `launch_persistent_context` against the shared ./profile/ directory, and
# Chromium's SingletonLock only permits one process per profile dir at a
# time. Without this lock, a Publish run with N selected platforms races
# N Chromiums and (N-1) fail with TargetClosedError. The lock turns
# concurrent posts into a queue — the user can still trigger them in
# parallel, the sidecar just runs them one after another.
_post_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# HTTP schemas
# ---------------------------------------------------------------------------
class PostRequest(BaseModel):
    """Inbound post submission from the Node agent.

    `platform` selects which platforms/*.py handler runs. Other fields are
    validated per-platform inside the dispatcher:
      - reddit: requires `subreddit` + `body` (self-post text).
      - hn: requires exactly one of `body` (self-post) or `url` (link post).
    """

    platform: str
    title: str
    body: str | None = None      # reddit self-posts + HN self-posts
    url: str | None = None       # HN link submissions only
    subreddit: str | None = None  # reddit-only


class PostResponse(BaseModel):
    ok: bool
    url: str | None = None
    error: str | None = None


class LoginStartRequest(BaseModel):
    """Which platforms to open login tabs for. Order in the list determines
    the order tabs are stacked — typically irrelevant since the user clicks
    between tabs freely."""

    platforms: list[str]


class LoginResponse(BaseModel):
    ok: bool
    platforms: list[str] | None = None
    error: str | None = None


class LoginStatusRequest(BaseModel):
    """Which platforms to detect login for. Usually the same list the
    caller passed to /login/start."""

    platforms: list[str]


class LoginStatusResponse(BaseModel):
    ok: bool
    # Per-platform boolean. Missing key = unknown platform; false = checked
    # and not detected; true = checked and detected. The dashboard treats
    # both missing and false as "no tick yet".
    status: dict[str, bool] | None = None
    error: str | None = None


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------
app = FastAPI(title="pincer-browser-sidecar")

# CORS: the dashboard runs on a different port (Next dev server defaults to
# 3000) so it's a cross-origin caller from the browser's POV. The regex
# matches any localhost / 127.0.0.1 port on http or https — permissive but
# strictly local, which is the right surface for a developer-machine sidecar.
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"https?://(localhost|127\.0\.0\.1)(:\d+)?",
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


@app.get("/health")
async def health() -> dict[str, Any]:
    """Liveness check the dashboard / Node agent calls each loop iteration.
    If this stops responding, the caller should restart the sidecar."""
    return {"ok": True, "service": "pincer-browser-sidecar"}


@app.post("/post", response_model=PostResponse)
async def post(req: PostRequest) -> PostResponse:
    """Submit a post on the named platform and return the resulting URL.

    Errors are returned as `{ok: false, error: "..."}` rather than HTTP 500 so
    the caller can surface them to the dashboard without parsing status codes.
    The sidecar should never crash on a single bad post.
    """
    log.info("post received: platform=%s title=%r", req.platform, req.title[:60])

    # Reject /post while a login session is open — both want exclusive access
    # to the same Chromium profile dir and would race on the SingletonLock.
    if _login_ctx is not None:
        return PostResponse(
            ok=False,
            error="a login session is in progress; call /login/finish first",
        )

    # Serialize. When the dashboard fires concurrent /post calls (e.g. a
    # single Publish click targeting Reddit + HN), two Chromiums would
    # otherwise race to take the SingletonLock on ./profile/ and the
    # loser would die with TargetClosedError. The lock turns it into a
    # FIFO queue — total latency is the same, but each post completes
    # cleanly. Acquired here (not lower in the dispatch) so the wait is
    # visible in logs as a single "waiting on post lock" if it ever
    # becomes a problem.
    async with _post_lock:
        try:
            if req.platform == "reddit":
                if not req.subreddit:
                    return PostResponse(
                        ok=False,
                        error="reddit posts require a 'subreddit' field",
                    )
                if not req.body:
                    return PostResponse(
                        ok=False,
                        error="reddit posts require a 'body' field",
                    )
                post_url = await post_to_reddit(req.subreddit, req.title, req.body)
            elif req.platform in ("hn", "hackernews"):
                # HN takes a body (self-post) OR a url (link submission), never both.
                # XOR check: exactly one must be non-None.
                if (req.body is None) == (req.url is None):
                    return PostResponse(
                        ok=False,
                        error="hn posts require exactly one of 'body' or 'url'",
                    )
                post_url = await post_to_hn(req.title, text=req.body, url=req.url)
            else:
                return PostResponse(
                    ok=False,
                    error=f"unsupported platform: {req.platform!r}",
                )
        except Exception as e:
            log.exception("post failed")
            return PostResponse(ok=False, error=f"{type(e).__name__}: {e}")

    return PostResponse(ok=True, url=post_url)


@app.post("/login/start", response_model=LoginResponse)
async def login_start(req: LoginStartRequest) -> LoginResponse:
    """Open a Chromium window with one login tab per requested platform.

    The browser stays open until /login/finish is called. The user logs in
    manually in each tab (typing credentials, solving captchas, clicking MFA).
    When they're done, the dashboard calls /login/finish to close the browser
    cleanly so Chromium flushes cookies to the profile directory.

    Only one login session can be active at a time — Chromium's SingletonLock
    prevents concurrent processes on the same profile dir.
    """
    global _login_playwright, _login_ctx

    if _login_ctx is not None:
        return LoginResponse(
            ok=False,
            error="a login session is already in progress; call /login/finish first",
        )

    # Validate everything up front so we don't launch Chromium for an
    # unrecoverable request.
    if not req.platforms:
        return LoginResponse(ok=False, error="no platforms provided")

    unknown = [p for p in req.platforms if p not in LOGIN_URLS]
    if unknown:
        return LoginResponse(ok=False, error=f"unknown platform(s): {unknown}")

    log.info("opening login session for: %s", req.platforms)
    # Sweep stale Singleton* lock files if the previous Chromium owner is
    # dead. See platforms/__init__.py::clear_stale_singleton for the why.
    clear_stale_singleton(PROFILE_DIR)
    try:
        # async_playwright() is normally used as `async with` — that scopes
        # cleanup to a function. We need it to live across HTTP requests, so
        # call .start() manually and stash both objects at module scope. The
        # symmetric .stop() happens in /login/finish.
        _login_playwright = await async_playwright().start()
        _login_ctx = await _login_playwright.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=False,
            # Same stealth knobs as platforms/*.py — login and runtime share
            # a fingerprint so anti-bot doesn't notice "the browser changed"
            # between session start and runtime posting.
            ignore_default_args=["--enable-automation"],
            args=["--disable-blink-features=AutomationControlled"],
        )
        await _login_ctx.add_init_script(
            "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });"
        )

        # One tab per platform. The user switches between them freely; cookies
        # for each site save to the same ./profile directory regardless.
        for platform in req.platforms:
            page = await _login_ctx.new_page()
            await page.goto(LOGIN_URLS[platform])

        return LoginResponse(ok=True, platforms=req.platforms)
    except Exception as e:
        # If anything in launch/goto fails, tear down whatever did succeed so
        # the next /login/start call can try again cleanly.
        log.exception("login_start failed")
        try:
            if _login_ctx is not None:
                await _login_ctx.close()
        except Exception:
            pass
        try:
            if _login_playwright is not None:
                await _login_playwright.stop()
        except Exception:
            pass
        _login_ctx = None
        _login_playwright = None
        return LoginResponse(ok=False, error=f"{type(e).__name__}: {e}")


@app.post("/login/finish", response_model=LoginResponse)
async def login_finish() -> LoginResponse:
    """Close the in-flight Chromium and flush cookies to the profile dir.

    Idempotent-ish: returns ok=False if no session is active, but otherwise
    always tries to clean up state even if the underlying close errors out
    (e.g. the user manually killed Chromium). Future /login/start calls
    will work after this returns regardless.
    """
    global _login_playwright, _login_ctx

    if _login_ctx is None:
        return LoginResponse(ok=False, error="no login session in progress")

    log.info("closing login session and flushing profile")
    # Catch and log close errors — we want to reset state even if cleanup
    # partially fails, otherwise the sidecar would be stuck thinking a session
    # is still active.
    try:
        await _login_ctx.close()
    except Exception as e:
        log.warning("error closing login context: %s", e)

    try:
        if _login_playwright is not None:
            await _login_playwright.stop()
    except Exception as e:
        log.warning("error stopping playwright: %s", e)

    _login_ctx = None
    _login_playwright = None
    return LoginResponse(ok=True)


# ---------------------------------------------------------------------------
# /login/status — per-platform login detection for the live session.
#
# The dashboard polls this every few seconds while Chromium is open and
# uses the booleans to render a tick next to each platform row. When all
# selected platforms come back true, the "I'm done logging in" button
# unlocks. Most checks are free (cookie inspection); URL fallbacks only
# fire when the cookie isn't present, which keeps the poll cheap.
# ---------------------------------------------------------------------------
@app.post("/login/status", response_model=LoginStatusResponse)
async def login_status(req: LoginStatusRequest) -> LoginStatusResponse:
    if _login_ctx is None:
        return LoginStatusResponse(ok=False, error="no login session in progress")

    status: dict[str, bool] = {}
    for platform in req.platforms:
        # Discord doesn't expose a stable cookie or API for "am I signed
        # in?" — it ships the token in memory only. Detect by URL pattern
        # of any open tab instead.
        if platform == "discord":
            status[platform] = await _detect_discord_login()
            continue

        cfg = LOGIN_DETECT.get(platform)
        if cfg is None:
            # Unknown platform → can't detect, treat as not-signed-in.
            status[platform] = False
            continue

        # Cookie-first: no network calls, just a peek at the context.
        if await _cookie_present(cfg["cookie_domain"], cfg["cookie_name"]):
            status[platform] = True
            continue

        # URL fallback: shares cookies with the live tabs via the context's
        # APIRequestContext. Slower than the cookie check but catches cases
        # where the auth cookie has a slightly different name or path than
        # our table expects.
        status[platform] = await _verify_via_url(
            cfg["verify_url"], cfg.get("verify_logged_in_marker")
        )

    return LoginStatusResponse(ok=True, status=status)


async def _cookie_present(domain_suffix: str, name: str) -> bool:
    """True if a non-empty cookie matching name + domain suffix exists
    in the live context. Returns False on any error so the dashboard just
    keeps polling instead of crashing on a transient hiccup."""
    if _login_ctx is None:
        return False
    try:
        cookies = await _login_ctx.cookies()
        for c in cookies:
            if (
                c.get("name") == name
                and domain_suffix in c.get("domain", "")
                and c.get("value")
            ):
                return True
        return False
    except Exception as e:
        log.warning("cookie check failed for %s/%s: %s", domain_suffix, name, e)
        return False


async def _verify_via_url(url: str, marker: str | None) -> bool:
    """Fetch `url` through the context's request API (so cookies match the
    user's open tabs) and decide signed-in / not-signed-in.

    Decision rules:
      - HTTP status >= 400 → not signed in.
      - If `marker` is provided, search for it (case-insensitive) in the
        response body — its presence means signed in.
      - If no marker, any sub-400 status counts as signed in.

    Returns False on any error so polling never breaks the UI."""
    if _login_ctx is None:
        return False
    try:
        # max_redirects=0 so we don't follow a "redirect to /login" and
        # then read a 200 from the login page itself.
        resp = await _login_ctx.request.get(url, max_redirects=0, timeout=5000)
        if resp.status >= 400 or resp.status in (301, 302, 303, 307, 308):
            return False
        if marker is None:
            return True
        body = await resp.text()
        return marker.lower() in body.lower()
    except Exception as e:
        log.warning("url verify failed for %s: %s", url, e)
        return False


async def _detect_discord_login() -> bool:
    """Discord moves its auth token to in-memory storage to defeat token-
    stealing extensions, so cookie/localStorage checks don't help. Use a
    proxy signal: any open tab whose URL has moved past /login to
    /channels/* indicates the user successfully signed in."""
    if _login_ctx is None:
        return False
    try:
        for page in _login_ctx.pages:
            if "discord.com/channels" in page.url:
                return True
        return False
    except Exception as e:
        log.warning("discord detection failed: %s", e)
        return False
