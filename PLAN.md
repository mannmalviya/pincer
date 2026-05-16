# Pincer — Hackathon v0

> *Pincer gets a grip on your launch.* Multi-platform launch agent built on OpenClaw — the claw motif is intentional and free brand equity for the demo.

## Context

24-hour NVIDIA hackathon (Cloud + NemoClaw bonus track). **Pincer** is an autonomous marketing agent for indie hackers / project launchers: it generates platform-tailored posts, posts them to Reddit + Discord, monitors comments, surfaces hard ones to a human via a dashboard inbox, and tracks analytics. Powered by OpenClaw (Node.js agent framework by Peter Steinberger) + NVIDIA Nemotron 3 Super, deployed on a Brev launchable, wrapped in NemoClaw's OpenShell sandbox for the bonus prize track.

**Why this scope:** the original "post + comment-loop + escalation" workflow is the actual painful part of launch marketing — 30 min of posting + days of comment babysitting. Removing comment monitoring would gut the demo. Auto-replies were dropped because a hallucinated bot reply on a real subreddit during the live demo would torpedo the judging.

**HN is intentionally deferred** — no official write API, and the user noted Browser Harness (browser-automation project) can plug in later. v0 ships HN read-only via Algolia API for analytics; posting is a clearly-shaped extension point.

## Architecture

Split deployment: agent + SQLite + browser-harness sidecar run on Brev 24/7; dashboard runs on the user's laptop and talks to the agent over HTTP.

```
[User's laptop]                  [Brev launchable]
┌──────────────────────┐         ┌─────────────────────────────────────────────────────────┐
│ Next.js Dashboard    │         │                                                         │
│ - Onboarding wizard  │  HTTPS  │  Node Agent (OpenClaw)        Python sidecar            │
│ - Compose / approve  │ ──────► │  - HTTP API server      ────► (browser-harness)         │
│ - Live analytics     │         │  - Skills orchestration  HTTP  - FastAPI wrapping       │
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

                 Agent + sidecar wrapped in NemoClaw / OpenShell sandbox.
                 Egress policy: reddit.com, x.com, instagram.com, tiktok.com,
                 news.ycombinator.com, integrate.api.nvidia.com,
                 cloud.browser-use.com (if using their hosted browsers).

                 Auth: dashboard sends a shared bearer token (env var on
                 both sides) on every request. The Python sidecar only
                 accepts requests from the Node agent on localhost.
```

**Why the split (Shape 1):** The agent needs to run 24/7 (poll loop + comment monitoring), which a laptop can't deliver. Brev gives us always-on hosting with NemoClaw + NIM pre-wired. The dashboard is the operator's local viewer/controller — keeping it on the user's machine matches the single-user, clone-and-run-local product story. SQLite stays single-host (lives with the agent, which is the only writer), so no replication or distributed-database concerns. Dashboard never touches the DB directly; every page reads via the agent's HTTP API and renders the JSON.

**Why browser-harness sidecar (not platform APIs):** Every supported platform (Reddit, X, Instagram, TikTok, HN) gets handled the same way — drive a real browser, no per-platform API integration, no developer-app registrations. The Node agent stays the system of record (orchestration, DB, NIM); browser-harness handles the irreducibly browser-shaped work. Sidecar (not embedded) because browser-harness is Python and Pincer's agent is TS — easier to keep them in their native languages than force a cross-language bridge inside one process. Captchas + stealth are delegated to Browser Use Cloud (free tier: 3 concurrent browsers + captcha solving included).

**Why SQLite still:** Single writer (the agent), single file on Brev's persistent disk, trivial backup. Skip Postgres.

**Why NIM not local Ollama:** Cloud track. NIM at `integrate.api.nvidia.com` is OpenAI-compatible, free during preview, and removes the "did the model load" failure mode from the demo. Nemotron 3 Super 120B for the headline; fall back to Nemotron 3 Nano for the cheap classification step (FAQ vs needs-human).

**Why NemoClaw on top:** bonus track. The egress policy YAML is the demo artifact — show judges that the agent is constrained to four hosts and any drift triggers a TUI approval prompt.

## File structure

```
pincer/
├── agent/                          # Runs on Brev. OpenClaw agent (Node.js 22+)
│   ├── openclaw.json               # agent config: skills allowlist, model = nemotron-3-super
│   ├── src/
│   │   ├── loop.ts                 # main poll loop (every 60s)
│   │   ├── server.ts               # HTTP API server (Fastify/Hono) — dashboard hits this
│   │   ├── nemotron.ts             # NIM client (OpenAI-compat SDK, base_url=integrate.api.nvidia.com)
│   │   ├── db.ts                   # better-sqlite3 wrapper, single writer
│   │   ├── browser-client.ts       # thin HTTP client to the Python sidecar (localhost)
│   │   └── platforms/
│   │       ├── reddit.ts           # builds Reddit-specific browser-harness tasks; calls browser-client
│   │       ├── discord.ts          # builds Discord-specific browser-harness tasks
│   │       ├── x.ts                # X / Twitter tasks
│   │       ├── instagram.ts        # Instagram tasks
│   │       ├── tiktok.ts           # TikTok tasks
│   │       └── hn.ts               # Hacker News tasks (now also via browser-harness)
│   ├── data.db                     # SQLite lives next to the agent on Brev, gitignored
│   └── skills/                     # SKILL.md folders, AgentSkills format
│       ├── generate-post/SKILL.md          # platform-tailored post drafting
│       ├── post-to-platform/SKILL.md       # generic "post to <platform>"; routes via platforms/*
│       ├── poll-comments/SKILL.md          # pulls new comments since last cursor (per platform)
│       ├── classify-comment/SKILL.md       # FAQ / needs-human / spam (cheap Nano call)
│       └── escalate-to-human/SKILL.md      # writes row to escalations table
│
├── browser-sidecar/                # Runs on Brev. Python service wrapping browser-harness
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
│   └── lib/agent-client.ts         # fetch wrapper: bearer auth, base URL from PINCER_AGENT_URL env
│
├── policies/
│   └── nemoclaw.yaml               # egress allowlist, demo artifact (Brev side)
└── README.md                       # setup: agent + sidecar on Brev, dashboard on laptop
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

## Skills to build (5 total)

Each is a directory with `SKILL.md` (YAML frontmatter + natural-language instructions per OpenClaw spec). The skill body tells Nemotron how/when to invoke the underlying TS function exposed via the OpenClaw plugin loader. Anything that touches a browser routes through `browser-client.ts` → Python sidecar → real Chrome.

| Skill | Reuses | Purpose |
|---|---|---|
| `generate-post` | `nemotron.ts` | One product brief in → N platform-specific drafts out. Reddit = problem-first, X = punchy, HN = blunt title. |
| `post-to-platform` | `platforms/<name>.ts` → `browser-client.ts` | Generic submit. Routes by platform: each `platforms/<name>.ts` knows how to phrase the task for browser-harness ("post to /r/test with title X and body Y"). Persists `platform_posts` row + URL on success. |
| `poll-comments` | `platforms/<name>.ts` → `browser-client.ts` | Per-platform cursor-based pull via browser-harness, dedupe on `external_id`, insert into `comments`. |
| `classify-comment` | `nemotron.ts` (Nano) | Returns one of `faq` / `needs_human` / `spam`. Cheap call so we can run it on every new comment. |
| `escalate-to-human` | `db.ts` | If `needs_human`, draft a tentative reply with Nemotron Super, write `escalations` row. Dashboard inbox picks it up. |

## 24-hour schedule

Time-boxed. If a phase runs over, drop the listed cut-line items, not the next phase.

| Hours | Milestone | Cut-line if behind |
|---|---|---|
| 0-1 | Brev launchable up. NemoClaw installed (`curl … nemoclaw.sh`). NIM API key in env. Browser Use Cloud API key obtained. Repo skeleton + db schema. | — |
| 1-3 | Python sidecar booted with browser-harness. `nemotron.ts` calling NIM works. Manual test: a one-shot script posts to r/test via the sidecar. | — |
| 3-6 | OpenClaw agent runs `generate-post` → `post-to-platform` (Reddit only) end-to-end from CLI. Session cookies persist across runs. | — |
| 6-10 | Next.js dashboard: onboarding wizard + compose page. "Draft posts" button hits agent over a thin HTTP shim. Wizard captures username + password, kicks off a browser-harness login session, stores cookies. | Drop onboarding wizard, pre-seed cookies in DB. |
| 10-14 | `poll-comments` skill + comment loop running on 60s timer. Comments visible in dashboard. Add X as the second supported platform. | Reddit only, skip X. |
| 14-18 | `classify-comment` + `escalate-to-human`. Inbox page renders pending escalations with one-click reply. | Drop suggested-reply drafting, just surface raw comment. |
| 18-21 | Analytics page (recharts), `analytics_snapshots` populated every 5 min. HN added (read + post via browser-harness). | Drop HN, Reddit + X only. |
| 21-23 | NemoClaw policy YAML locked down to the egress allowlist. Verify the TUI approval prompt fires when you try to curl elsewhere — this is the bonus-track demo moment. | Drop NemoClaw, accept losing bonus track. |
| 23-24 | Demo script rehearsal. README. Submission video. | — |

## Critical files to create/modify

- [agent/openclaw.json](agent/openclaw.json) — sets agent name, model `nemotron-3-super`, skills allowlist
- [agent/src/nemotron.ts](agent/src/nemotron.ts) — OpenAI SDK pointed at `https://integrate.api.nvidia.com/v1`, two helpers: `super()` and `nano()`
- [agent/src/server.ts](agent/src/server.ts) — HTTP API server: `/api/accounts`, `/api/draft`, `/api/publish`, `/api/escalations`, `/api/posts/:id`. Bearer-auth via `PINCER_AGENT_TOKEN`.
- [agent/src/browser-client.ts](agent/src/browser-client.ts) — fetch wrapper around the Python sidecar at `http://localhost:<port>`. Handles task submission, cookie persistence, result polling.
- [agent/src/loop.ts](agent/src/loop.ts) — `setInterval(60_000)` calling `poll-comments` then `classify-comment` for each new row
- [agent/src/db.ts](agent/src/db.ts) — single better-sqlite3 connection, prepared statements for the 6 tables; AES helpers for `session_encrypted`
- [agent/src/platforms/](agent/src/platforms/) — one file per platform, each exposes `submit(content) / pollComments(cursor) / fetchMetrics(externalId)` and translates them into browser-harness task strings
- [agent/skills/*/SKILL.md](agent/skills/) — 5 skill files, AgentSkills YAML-frontmatter format
- [browser-sidecar/app.py](browser-sidecar/app.py) — FastAPI wrapping browser-harness. Endpoints: `POST /run-task` (natural-language task + session cookies in, result + new cookies out), `GET /health`
- [dashboard/lib/agent-client.ts](dashboard/lib/agent-client.ts) — fetch wrapper, reads `PINCER_AGENT_URL` + `PINCER_AGENT_TOKEN` from env, attaches bearer header to every request
- [dashboard/app/inbox/page.tsx](dashboard/app/inbox/page.tsx) — server component fetching `GET /api/escalations?status=pending` via agent-client
- [dashboard/app/compose/page.tsx](dashboard/app/compose/page.tsx) — POSTs to agent's `/api/draft` (returns N platform drafts); "Approve & post all" calls `/api/publish`
- [policies/nemoclaw.yaml](policies/nemoclaw.yaml) — egress allowlist, demo artifact

## Verification

End-to-end demo run (also the script for the submission video):

1. Fresh Brev box. Run `curl … nemoclaw.sh | bash`, accept defaults, pick `nemotron-3-super` via NIM. Grab a Browser Use Cloud API key from `cloud.browser-use.com/new-api-key`.
2. **On Brev (sidecar):** `cd pincer/browser-sidecar && uv sync && uv run uvicorn app:app --port 9000` (boots the Python service). With `BROWSER_USE_CLOUD_KEY` in `.env`, browser-harness uses a hosted browser; otherwise it spins a local headless Chrome.
3. **On Brev (agent):** `cd pincer/agent && npm install && npm run db:init && npm run start` (boots OpenClaw agent + HTTP API on port 8080, configured to call the sidecar at localhost:9000). Expose port 8080 publicly via the Brev launchable; note the URL + the `PINCER_AGENT_TOKEN` from `.env`.
4. **On laptop:** `cd pincer/dashboard && PINCER_AGENT_URL=https://<brev-url> PINCER_AGENT_TOKEN=<token> npm run dev`. Dashboard boots at `localhost:3000`, talking to the Brev agent.
5. Open dashboard → Onboarding → pick platforms (Reddit, X). For each, paste username + password. Dashboard POSTs to agent, agent forwards a `login` task to the sidecar; browser-harness logs in, returns cookies, agent encrypts + stores them in `accounts.session_encrypted`.
6. Compose page → paste a 3-line product brief ("We just launched FooLint, a TypeScript linter for…"). Click **Draft posts**. Two platform-specific drafts render side-by-side. Edit one. Click **Approve & post all**.
7. Within seconds, the post URLs render on the page (sidecar drove the browser, sites confirm the submit).
8. Have a teammate comment on the Reddit post with both an FAQ-style question ("Is it free?") and a hard one ("How does this compare to Biome's quirks-mode?"). Wait ≤60s.
9. Inbox tab shows one pending escalation (the hard one) with a Nemotron-drafted suggested reply. Click **Edit & send** → reply appears on Reddit (again via the sidecar).
10. Analytics tab: chart shows comment-count growing.
11. **NemoClaw bonus moment:** in another terminal inside the sandbox, `curl https://example.com`. The OpenShell TUI prompts for approval. Deny it. Show judges `policies/nemoclaw.yaml` — only the platform domains + NIM + Browser Use Cloud are allowed.

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
4. **NemoClaw setup eats too long.** It's early-preview software. Hard time-box it to the 21-23h slot; if it doesn't work, ship without and skip the bonus track.
5. **Sidecar process death.** If browser-harness or its Chrome dies mid-loop, the agent silently stops posting. Mitigation: agent calls `/health` on every loop iteration; on failure, restart the sidecar via `pm2` and skip the cycle.
6. **Session expiry.** Cookies for any platform can be invalidated by the platform at any time. Mitigation: on a `login required` task failure, surface an "X needs re-auth" escalation in the dashboard instead of silently failing.
