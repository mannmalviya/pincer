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

import logging
from pathlib import Path
from typing import Any

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from playwright.async_api import BrowserContext, Playwright, async_playwright
from pydantic import BaseModel

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
