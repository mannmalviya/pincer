# Pincer — Hackathon v0

> *Pincer gets a grip on your launch.* Multi-platform launch agent powered by NVIDIA Nemotron.

## Context

24-hour NVIDIA hackathon (Cloud track). **Pincer** is an autonomous marketing agent for indie hackers / project launchers: it generates platform-tailored posts, posts them to Reddit + Discord, monitors comments, surfaces hard ones to a human via a dashboard inbox, and tracks analytics. Powered by NVIDIA Nemotron 3 via NIM (Super for drafting, Nano for classification), deployed on a Brev launchable.

**Why this scope:** the original "post + comment-loop + escalation" workflow is the actual painful part of launch marketing — 30 min of posting + days of comment babysitting. Removing comment monitoring would gut the demo. Auto-replies were dropped because a hallucinated bot reply on a real subreddit during the live demo would torpedo the judging.

**HN is intentionally deferred** — no official write API, and the user noted Browser Harness (browser-automation project) can plug in later. v0 ships HN read-only via Algolia API for analytics; posting is a clearly-shaped extension point.

## Architecture

Split deployment: agent + SQLite + browser-harness sidecar run on Brev 24/7; dashboard runs on the user's laptop and talks to the agent over HTTP.

```
[User's laptop]                  [Brev launchable]
┌──────────────────────┐         ┌─────────────────────────────────────────────────────────┐
│ Next.js Dashboard    │         │                                                         │
│ - Onboarding wizard  │  HTTPS  │  Node Agent (Fastify)         Python sidecar            │
│ - Compose / approve  │ ──────► │  - HTTP API server      ────► (browser-harness)         │
│ - Live analytics     │         │  - 60s watch loop        HTTP  - FastAPI wrapping       │
│ - Escalation inbox   │ ◄────── │  - Calls Nemotron NIM   ◄────   browser-harness         │
│ (stateless — no DB)  │  JSON   │                                - Drives a real Chrome   │
└──────────────────────┘         │         │                       via CDP                 │
                                 │         ▼                          │                    │
                                 │  SQLite (./data.db)                ▼                    │
                                 │  posts, comments, escalations,  Chrome (headless or     │
                                 │  analytics_snapshots,           Browser Use Cloud       │
                                 │  accounts (with session         hosted browser)         │
                                 │  cookies, not API tokens)                               │
                                 └─────────────────────────────────────────────────────────┘

                 Egress (informational): reddit.com, x.com, instagram.com,
                 tiktok.com, news.ycombinator.com, integrate.api.nvidia.com,
                 cloud.browser-use.com (if using their hosted browsers).

                 Auth: dashboard sends a shared bearer token (env var on
                 both sides) on every request. The Python sidecar only
                 accepts requests from the Node agent on localhost.
```

**Why the split (Shape 1):** The agent needs to run 24/7 (poll loop + comment monitoring), which a laptop can't deliver. Brev gives us always-on hosting in the same network neighborhood as NIM. The dashboard is the operator's local viewer/controller — keeping it on the user's machine matches the single-user, clone-and-run-local product story. SQLite stays single-host (lives with the agent, which is the only writer), so no replication or distributed-database concerns. Dashboard never touches the DB directly; every page reads via the agent's HTTP API and renders the JSON.

**Why browser-harness sidecar (not platform APIs):** Every supported platform (Reddit, X, Instagram, TikTok, HN) gets handled the same way — drive a real browser, no per-platform API integration, no developer-app registrations. The Node agent stays the system of record (orchestration, DB, NIM); browser-harness handles the irreducibly browser-shaped work. Sidecar (not embedded) because browser-harness is Python and Pincer's agent is TS — easier to keep them in their native languages than force a cross-language bridge inside one process. Captchas + stealth are delegated to Browser Use Cloud (free tier: 3 concurrent browsers + captcha solving included).

**Why SQLite still:** Single writer (the agent), single file on Brev's persistent disk, trivial backup. Skip Postgres.

**Why NIM not local Ollama:** Cloud track. NIM at `integrate.api.nvidia.com` is OpenAI-compatible, free during preview, and removes the "did the model load" failure mode from the demo. Nemotron 3 Super 120B for the headline; fall back to Nemotron 3 Nano for the cheap classification step (FAQ vs needs-human).

## File structure

```
pincer/
├── agent/                          # Runs on Brev. Node.js 22+ Fastify service.
│   ├── src/
│   │   ├── index.ts                # entrypoint: db init, start server, start watch loop
│   │   ├── server.ts               # Fastify factory: CORS, routes, error handler
│   │   ├── watch/loop.ts           # main 60s poll loop (with adaptive backoff per post)
│   │   ├── lib/nim.ts              # NIM client (OpenAI-shape fetch, base_url=integrate.api.nvidia.com)
│   │   ├── db.ts                   # better-sqlite3 wrapper, single writer
│   │   ├── routes/                 # one file per route group (posts, comments, stats, reply, ...)
│   │   └── platforms/
│   │       ├── reddit.ts           # Reddit public .json fetcher
│   │       └── hn.ts               # Hacker News v0 + Algolia fetchers
│   └── agent.sqlite                # SQLite lives next to the agent on Brev, gitignored
│
├── browser-sidecar/                # Runs on the laptop. Python service wrapping browser-harness
│   ├── pyproject.toml              # deps: fastapi, uvicorn, browser-harness
│   ├── app.py                      # FastAPI: POST /run-task accepts a natural-language task + cookies
│   └── agent-workspace/            # browser-harness's own workspace (domain skills emerge here)
│
├── dashboard/                      # Runs on user's laptop. Next.js 16 App Router
│   ├── app/
│   │   ├── onboarding/page.tsx     # first-run wizard: pick platforms, log in via in-browser session
│   │   ├── compose/page.tsx        # textarea → "draft posts" → per-platform preview → approve/post
│   │   ├── inbox/page.tsx          # escalations list, one-click reply (sends back through agent)
│   │   ├── analytics/page.tsx      # recharts: views, upvotes, comments-over-time per platform
│   │   └── api/                    # thin Next.js proxies that forward to the agent (auth + CORS)
│   └── lib/agent.ts                # fetch wrapper: base URL from NEXT_PUBLIC_AGENT_URL env
│
└── README.md                       # setup: agent on Brev, dashboard + sidecar on laptop
```

## Database schema (SQLite)

```sql
accounts(id, platform, handle, session_encrypted, created_at)
                                          -- session_encrypted: JSON blob of cookies +
                                          -- localStorage from the in-browser login,
                                          -- AES-encrypted with PINCER_SESSION_KEY
posts(id, content_md, created_at, status)              -- one logical "launch", many platform_posts
platform_posts(id, post_id, platform, external_id, posted_at, raw_url)
comments(id, platform_post_id, external_id, author, body, created_at, classification)
                                          -- classification: 'faq'|'needs_human'|'spam'|null
escalations(id, comment_id, status, suggested_reply, human_reply, resolved_at)
                                          -- status: 'pending'|'replied'|'dismissed'
analytics_snapshots(id, platform_post_id, captured_at, upvotes, views, comment_count)
```

## Capabilities to build (5 total)

The agent exposes these as HTTP routes (or internal helpers called by the watch loop). Anything that touches a browser routes through the Python sidecar on the laptop.

| Capability | Reuses | Purpose |
|---|---|---|
| `generate-post` | `lib/nim.ts` | One product brief in → N platform-specific drafts out. Reddit = problem-first, X = punchy, HN = blunt title. |
| `post-to-platform` | sidecar over HTTP | Generic submit. The sidecar's `platforms/<name>.py` knows how to drive the browser ("post to /r/test with title X and body Y"). Agent persists `platform_posts` row + URL on success. |
| `poll-comments` | `platforms/<name>.ts` | Per-platform cursor-based pull via Reddit/HN public APIs, dedupe on `external_id`, insert into `comments`. |
| `classify-comment` | `lib/nim.ts` (Nano) | Returns one of `faq` / `needs_human` / `spam`. Cheap call so we can run it on every new comment. |
| `escalate-to-human` | `db.ts` | If `needs_human`, draft a tentative reply with Nemotron Super, write `escalations` row. Dashboard inbox picks it up. |

## 24-hour schedule

Time-boxed. If a phase runs over, drop the listed cut-line items, not the next phase.

| Hours | Milestone | Cut-line if behind |
|---|---|---|
| 0-1 | Brev launchable up. NIM API key in env. Browser Use Cloud API key obtained. Repo skeleton + db schema. | — |
| 1-3 | Python sidecar booted with browser-harness. `lib/nim.ts` calling NIM works. Manual test: a one-shot script posts to r/test via the sidecar. | — |
| 3-6 | Agent runs `generate-post` → `post-to-platform` (Reddit only) end-to-end from CLI. Session cookies persist across runs. | — |
| 6-10 | Next.js dashboard: onboarding wizard + compose page. "Draft posts" button hits agent over a thin HTTP shim. Wizard captures username + password, kicks off a browser-harness login session, stores cookies. | Drop onboarding wizard, pre-seed cookies in DB. |
| 10-14 | `poll-comments` + comment loop running on 60s timer. Comments visible in dashboard. Add X as the second supported platform. | Reddit only, skip X. |
| 14-18 | `classify-comment` + `escalate-to-human`. Inbox page renders pending escalations with one-click reply. | Drop suggested-reply drafting, just surface raw comment. |
| 18-21 | Analytics page (recharts), `analytics_snapshots` populated every 5 min. HN added (read + post via browser-harness). | Drop HN, Reddit + X only. |
| 21-23 | Polish pass: settings page (poll interval, adaptive backoff), agent status hero on the dashboard, suggested replies via Nemotron Super for the inbox. | Skip settings page, ship with hardcoded interval. |
| 23-24 | Demo script rehearsal. README. Submission video. | — |

## Critical files to create/modify

- [agent/src/lib/nim.ts](agent/src/lib/nim.ts) — OpenAI-shape fetch pointed at `https://integrate.api.nvidia.com/v1`, used for both reply drafting and comment classification
- [agent/src/server.ts](agent/src/server.ts) — Fastify factory: registers CORS + every route group + uniform error handler
- [agent/src/routes/](agent/src/routes/) — one file per route group: `posts`, `comments`, `stats`, `reply`, `settings`, `backfill-user`, `health`, `onboarding`
- [agent/src/watch/loop.ts](agent/src/watch/loop.ts) — scheduler driven by `base_poll_interval_seconds` from settings; per-post adaptive due-time check
- [agent/src/db.ts](agent/src/db.ts) — single better-sqlite3 connection, schema-on-boot + idempotent column-add migrations
- [agent/src/platforms/](agent/src/platforms/) — one file per platform (`reddit.ts`, `hn.ts`), each exposes a `fetchPost(externalId)` returning normalized FetchedPost + FetchedComment shapes
- [browser-sidecar/app.py](browser-sidecar/app.py) — FastAPI wrapping browser-harness. Endpoints: `POST /run-task` (natural-language task + session cookies in, result + new cookies out), `GET /health`
- [dashboard/lib/agent.ts](dashboard/lib/agent.ts) — fetch wrapper, reads `NEXT_PUBLIC_AGENT_URL` from env, one helper per agent endpoint
- [dashboard/app/dashboard/inbox/page.tsx](dashboard/app/dashboard/inbox/page.tsx) — escalations list (suggested-reply via the agent's `/comments/:id/draft-reply` route)
- [dashboard/app/dashboard/newpost/page.tsx](dashboard/app/dashboard/newpost/page.tsx) — drafts + per-platform publish flow

## Verification

End-to-end demo run (also the script for the submission video):

1. Fresh Brev box. Install Node 22 + build tools. Set `NIM_API_KEY` in env. Grab a Browser Use Cloud API key from `cloud.browser-use.com/new-api-key` (optional).
2. **On laptop (sidecar):** `cd pincer/browser-sidecar && uv sync && uv run uvicorn app:app --port 9000` (boots the Python service). With `BROWSER_USE_CLOUD_KEY` in `.env`, browser-harness uses a hosted browser; otherwise it spins a local Chrome via the user's existing profile.
3. **On Brev (agent):** `cd pincer/agent && npm install && npm run build && npm run start` (boots the Fastify agent on `0.0.0.0:8000` with the watch loop). Expose port 8000 publicly via the Brev launchable; note the secure-link URL.
4. **On laptop:** `cd pincer/dashboard && NEXT_PUBLIC_AGENT_URL=https://<brev-url> npm run dev`. Dashboard boots at `localhost:3000`, talking to the Brev agent.
5. Open dashboard → Onboarding → pick platforms (Reddit, X). For each, paste username + password. Dashboard POSTs to agent, agent forwards a `login` task to the sidecar; browser-harness logs in, returns cookies, agent encrypts + stores them in `accounts.session_encrypted`.
6. Compose page → paste a 3-line product brief ("We just launched FooLint, a TypeScript linter for…"). Click **Draft posts**. Two platform-specific drafts render side-by-side. Edit one. Click **Approve & post all**.
7. Within seconds, the post URLs render on the page (sidecar drove the browser, sites confirm the submit).
8. Have a teammate comment on the Reddit post with both an FAQ-style question ("Is it free?") and a hard one ("How does this compare to Biome's quirks-mode?"). Wait ≤60s.
9. Inbox tab shows one pending escalation (the hard one) with a Nemotron-drafted suggested reply. Click **Edit & send** → reply appears on Reddit (again via the sidecar).
10. Analytics tab: chart shows comment-count growing.

## Out of scope for v0 (mention in README as v1+)

- AI video generation
- Instagram + TikTok posting (browser-harness can drive them but each needs its own platform module; defer)
- Multi-user / auth on dashboard
- Auto-replies (only suggested replies + human approve)
- Sentiment analysis charts
- Cross-post deduplication / scheduling

## Risks

1. **Captchas during live demo.** Browser automation triggers captchas more often than API integrations. Mitigation: rely on Browser Use Cloud's free-tier captcha solving; pre-warm sessions before judging starts so each platform has fresh cookies.
2. **Account flagging by anti-bot systems.** Reddit + X have aggressive heuristics. Mitigation: lean on browser-harness's domain skills (human-like timing, no parallel sessions per platform), demo against `r/test` or a sub the team mods.
3. **NIM rate limits.** Free preview tier may throttle. Have an Ollama-on-Brev fallback ready: `OLLAMA_BASE_URL` env switch in `nemotron.ts`.
4. **Sidecar process death.** If browser-harness or its Chrome dies mid-loop, the agent silently stops posting. Mitigation: agent calls `/health` on every loop iteration; on failure, restart the sidecar via `pm2` and skip the cycle.
5. **Session expiry.** Cookies for any platform can be invalidated by the platform at any time. Mitigation: on a `login required` task failure, surface an "X needs re-auth" escalation in the dashboard instead of silently failing.
