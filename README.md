# Pincer

Pincer is an autonomous launch agent for indie hackers. It drafts platform-tailored posts, publishes to Reddit, Hacker News, and Bluesky, then watches every comment and surfaces only the ones worth your time. Powered by NVIDIA Nemotron 3 via NIM.

Built in 24 hours for the NVIDIA Nemotron hackathon (Cloud track).

## What it does

A typical launch on Reddit, Hacker News, and Bluesky burns thirty minutes posting and the next several days babysitting comment threads. Pincer collapses both halves of that workflow into a single pipeline:

1. You point Pincer at your GitHub repo. Nemotron reads the README, builds a structured profile of the project, and asks a few short clarifying questions so future replies sound like you.
2. You pick the platforms you want to launch on. Pincer opens a Chromium window so you log in once per platform; cookies persist locally for every later post.
3. You draft a post in plain English. Nemotron rewrites it once per platform in the right tone, length, and format.
4. Pincer publishes through a real browser (no platform APIs, no developer-app approvals) and starts a 60-second watcher on each post.
5. New comments are pulled, classified by Nemotron Nano, and shown in a single feed. Drafted replies are one click away, grounded in the project context you gave during onboarding.

## Features

- Project-aware drafting. Nemotron Super 120B reads your repo and tailors posts and replies to your actual product, not a generic template.
- Multi-platform publishing. Reddit, Hacker News, and Bluesky via deterministic Playwright flows. No per-platform API keys.
- Adaptive 60s watcher. Each post is polled on a cadence that stretches with age, so a thirty-day-old launch does not waste rate limits.
- Comment classification. Nemotron Nano 30B labels every reply (question, praise, hostile, low-effort) so you only read what needs attention.
- One-click reply drafting. Replies are grounded in both the launch post and the project profile so they sound human and stay on-message.
- Backfill by username. Paste a Reddit, HN, or Bluesky handle and Pincer enrolls every public post the user has ever made into the watch loop.
- Live analytics. Score and comment-count snapshots over time, rendered with recharts in the dashboard.
- Single-file SQLite. The agent owns one database file; backup is `cp agent.sqlite somewhere.sqlite`.

## Architecture

Three processes, two machines.

```text
[User's laptop]                                [Brev launchable]
+----------------------+                       +------------------------------+
| Next.js dashboard    |                       | Pincer agent (Node.js)       |
|  - Onboarding wizard |  HTTPS  /posts        |  - Fastify HTTP API          |
|  - Compose + approve | ----->  /comments     |  - 60s adaptive watch loop   |
|  - Comments inbox    | <-----  /reply        |  - Calls Nemotron via NIM    |
|  - Live analytics    |         /stats        |  - SQLite (single file)      |
+----------------------+                       +------------------------------+
            |
            |  HTTP (localhost:9000)
            v
+----------------------+
| Browser sidecar      |
|  - FastAPI service   |
|  - Playwright flows  |
|  - Persistent profile|
|    (cookies on disk) |
+----------------------+
            |
            v
   Reddit / HN / Bluesky
```

Why split this way:

- The agent has to run 24/7 (poll loop, comment monitoring). A laptop cannot deliver that. Brev gives always-on hosting in the same network neighborhood as NIM.
- Browser automation has to run on the user's machine the first time, because the user is the one logging in. The sidecar keeps the persistent Chromium profile on the laptop and exposes a local HTTP API so the dashboard can drive it.
- SQLite stays single-host (lives with the agent, which is the only writer). No replication, no Postgres.
- All LLM calls go through `integrate.api.nvidia.com` via an OpenAI-shape fetch wrapper. No vendor SDK.

## Prerequisites

- Node.js 22+ and npm
- Python 3.13+ with [uv](https://docs.astral.sh/uv/) (`pip install uv` or follow the uv install docs)
- A Chromium-based browser already installed on your machine (Playwright will manage its own Chromium under the hood)
- An NVIDIA NIM API key from <https://build.nvidia.com/> (free during preview)
- Optional: A GitHub personal access token if you want Pincer to read a private repo during onboarding

## Quick start (local dev, all three processes on your laptop)

Clone the repo and install dependencies for each component.

```bash
git clone https://github.com/mannmalviya/pincer.git
cd pincer

# 1. Agent (Node, port 8000)
cd agent
npm install
cp .env.example .env
# Edit .env and paste your NVIDIA NIM API key on the NIM_API_KEY line.
npm run dev &
cd ..

# 2. Browser sidecar (Python, port 9000)
cd browser-sidecar
uv sync
uv run playwright install chromium
cp .env.example .env
# Edit .env and paste the same NIM_API_KEY.
uv run uvicorn app:app --port 9000 &
cd ..

# 3. Dashboard (Next.js, port 3000)
cd dashboard
npm install
npm run dev
```

Open <http://localhost:3000> and click "Get started". The onboarding wizard walks you through repo analysis, platform selection, browser login, and (optional) backfill.

## Detailed setup

### Agent

Owns the SQLite database and the watch loop. Binds `0.0.0.0:8000` so it can be reached from the dashboard.

```bash
cd agent
npm install
cp .env.example .env
```

Edit `agent/.env`:

| Key                      | Default                                 | Required | Purpose                                                                       |
| ------------------------ | --------------------------------------- | -------- | ----------------------------------------------------------------------------- |
| `PORT`                   | `8000`                                  | no       | HTTP listen port                                                              |
| `HOST`                   | `0.0.0.0`                               | no       | Bind interface (use `127.0.0.1` for safety on dev laptops)                    |
| `DB_PATH`                | `/home/ubuntu/.pincer/agent.sqlite`     | no       | SQLite file location                                                          |
| `WATCH_INTERVAL_MS`      | `60000`                                 | no       | Base poll interval                                                            |
| `USER_AGENT`             | `pincer-agent/0.1 (...)`                | no       | Sent on every outbound Reddit/HN request. Generic UAs get rate-limited.       |
| `NIM_API_KEY`            | empty                                   | yes      | NVIDIA NIM key. Without it, reply drafting and repo analysis return HTTP 503. |
| `NIM_BASE_URL`           | `https://integrate.api.nvidia.com/v1`   | no       | NIM gateway. Only change if NVIDIA migrates the URL.                          |
| `NIM_PRIMARY_MODEL`      | `nvidia/nemotron-3-super-120b-a12b`     | no       | Used by drafting and reply paths.                                             |
| `NIM_FAST_MODEL`         | `nvidia/nemotron-3-nano-30b-a3b`        | no       | Used by comment classification.                                               |
| `NIM_ORCHESTRATOR_MODEL` | `nvidia/nemotron-mini-4b-instruct`      | no       | Routes tasks between primary and fast models.                                 |
| `NIM_REPLY_MODEL`        | `nvidia/nemotron-3-super-120b-a12b`     | no       | Override for reply drafts specifically.                                       |

Run it:

```bash
npm run dev        # tsx watch, hot reload
npm run build      # tsc compile to dist/
npm start          # node dist/index.js
npm run typecheck  # tsc --noEmit
```

On first boot the agent opens (or creates) `DB_PATH`, runs `schema.sql`, applies in-place migrations for any new columns or widened CHECK constraints, then starts the watch loop.

### Browser sidecar

Runs on the same machine as the dashboard because it spawns a real Chromium window for first-time login. Posts and reads happen against the user's logged-in session.

```bash
cd browser-sidecar
uv sync
uv run playwright install chromium
cp .env.example .env
```

Edit `browser-sidecar/.env`:

| Key            | Default                                         | Required | Purpose                                                              |
| -------------- | ----------------------------------------------- | -------- | -------------------------------------------------------------------- |
| `NIM_API_KEY`  | empty                                           | yes      | Same NVIDIA key as the agent. Dashboard back-fills from this file.   |
| `NIM_BASE_URL` | `https://integrate.api.nvidia.com/v1`           | no       | NIM gateway.                                                         |
| `NIM_MODEL`    | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | no       | Multimodal Nano-Omni for any LLM driven UI navigation.               |

Run it:

```bash
uv run uvicorn app:app --port 9000
```

Endpoints:

- `GET /health` — liveness probe.
- `POST /login/start` — opens Chromium with one login tab per requested platform.
- `POST /login/finish` — closes Chromium and flushes the profile to disk.
- `POST /login/status` — polled by the onboarding wizard to know when the user has finished logging in.
- `POST /post` — publishes a post on a named platform.

Per-platform Playwright flows live in `browser-sidecar/platforms/` (one file per platform). The persistent Chromium profile is stored under `browser-sidecar/profile/` and is gitignored.

### Dashboard

Next.js 16 App Router, mostly server components. Stateless: every page reads from the agent over HTTP.

```bash
cd dashboard
npm install
```

By default the dashboard talks to `http://localhost:8000`. To point it at a remote agent (for example a Brev deployment), create `dashboard/.env.local`:

```bash
NEXT_PUBLIC_AGENT_URL=https://port-8000-xxxxxx.brevlab.com
```

Run it:

```bash
npm run dev        # next dev, hot reload at http://localhost:3000
npm run build      # next build
npm start          # next start
npm run lint       # eslint
```

The dashboard does not need its own NIM key. It calls the agent's `/onboarding/analyze` and `/comments/:id/draft-reply` routes, and both run on the agent side using the agent's key.

## Usage walkthrough

1. **Onboarding** at <http://localhost:3000/onboarding>.
   - Project analysis: paste your repo URL and a GitHub personal access token. Pincer reads your README via the GitHub API and asks Nemotron to extract a structured project profile and a few clarifying questions. Answer the ones that matter; skip the rest. You can also skip the whole project step with "Skip for now" if you do not want to share a repo.
   - Platform selection: pick from Reddit, Hacker News, Bluesky, Discord, Instagram, and TikTok. The first three are publish-ready; the others are visible but disabled in this release.
   - Browser login: a Chromium window opens with one tab per platform you selected. Log in manually; the wizard auto-detects success per tab. Cookies persist locally.
   - Backfill (optional): enter your handle for any of Reddit, HN, or Bluesky and click "Pull all my posts" to enroll every public submission into the watch loop. Or paste specific URLs.

2. **Compose** at <http://localhost:3000/dashboard/newpost>.
   - Type your draft once in plain English.
   - Nemotron rewrites it per platform you have selected, in that platform's tone and format.
   - Edit any version inline, then approve and publish.

3. **Monitor** at <http://localhost:3000/dashboard>.
   - Stats cards show score, comment count, and tracked posts.
   - The comments feed shows every reply across every watched post in one timeline.
   - Click "Draft a reply" on any comment to have Nemotron write a grounded response. Copy it into the platform when you are happy.

4. **Settings** at <http://localhost:3000/dashboard/settings>.
   - Tune the watch loop's base interval and toggle adaptive polling.
   - Add more posts to backfill at any time.
   - Disconnect platforms or wipe the database from the Danger Zone.

## Project structure

```text
pincer/
├── agent/                          Node.js + Fastify. SQLite + 60s watch loop.
│   ├── src/
│   │   ├── index.ts                Entrypoint: DB init, server start, loop start.
│   │   ├── server.ts               Fastify factory: CORS, routes, error handler.
│   │   ├── config.ts               Env-driven knobs.
│   │   ├── db.ts                   better-sqlite3 singleton + migrations.
│   │   ├── schema.sql              DDL executed at startup.
│   │   ├── types.ts                Post / Snapshot / Comment shapes.
│   │   ├── routes/                 One file per route group.
│   │   ├── platforms/              reddit.ts, hn.ts, bluesky.ts, parse.ts.
│   │   ├── watch/                  loop.ts, tick.ts.
│   │   └── lib/                    http, nim client, orchestrator, project-context, logging.
│   └── .env.example
│
├── browser-sidecar/                Python + FastAPI. Wraps Playwright.
│   ├── app.py                      Endpoints (health, login, post).
│   ├── login.py                    Cross-platform login window driver.
│   ├── platforms/                  reddit.py, hackernews.py, bluesky.py.
│   ├── pyproject.toml
│   └── .env.example
│
├── dashboard/                      Next.js 16 App Router.
│   ├── app/
│   │   ├── page.tsx                Landing.
│   │   ├── onboarding/             Wizard (project, platforms, login, backfill).
│   │   ├── dashboard/              Overview, new post, settings, comments feed.
│   │   └── api/                    Thin proxies for browser-side calls.
│   ├── components/                 shadcn/ui primitives + site-specific glyphs.
│   ├── lib/
│   │   ├── agent.ts                AGENT_BASE + typed fetch helpers.
│   │   ├── platforms.ts            Platform metadata and ordering.
│   │   └── sidecar-env.ts          Reads sidecar's .env so dashboard inherits the NIM key.
│   └── public/                     Static assets.
│
├── CLAUDE.md                       Project-wide guidance.
├── PLAN.md                         Original hackathon plan + architecture notes.
└── README.md                       This file.
```

## Database schema

Three tables, all owned by the agent.

```sql
posts(id, platform, external_id, permalink, title, body, author,
      posted_at, watch_enabled, source, created_at)
  -- platform IN ('reddit','hn','bluesky')
  -- UNIQUE(platform, external_id) prevents double-registration

snapshots(id, post_id, fetched_at, score, comment_count)
  -- Append-only time series. One row per tick per post.

comments(id, post_id, external_id, author, body, posted_at, fetched_at,
         score, parent_external_id)
  -- UNIQUE(post_id, external_id) means INSERT OR IGNORE dedupes naturally.
```

Plus two singleton-ish tables: `project_context` (the onboarding profile) and `settings` (user-tunable watch loop knobs).

## Tech stack

| Layer              | Choice                                                                 | Why                                                              |
| ------------------ | ---------------------------------------------------------------------- | ---------------------------------------------------------------- |
| LLM                | NVIDIA Nemotron 3 (Super 120B, Nano 30B, Mini 4B Orchestrator) via NIM | Cloud track; OpenAI-compatible; free during preview              |
| Agent runtime      | Node.js 22 + Fastify                                                   | Same language as the dashboard; small surface                    |
| Database           | SQLite via better-sqlite3                                              | Single writer, single file, trivial backup                       |
| Dashboard          | Next.js 16 (App Router, server components)                             | Server-side data fetch from the agent without an extra API layer |
| Browser automation | Playwright via Python FastAPI                                          | One stack across login and posting; persistent profile on disk   |
| Charts             | recharts                                                               | Lightweight, server-renderable                                   |

## Deployment

The hackathon target is a [Brev](https://www.brev.dev/) launchable for the agent.

- Agent runs on the Brev VM, binds `0.0.0.0:8000`, with `DB_PATH` pointing at the VM's persistent disk.
- Browser sidecar stays on the user's laptop (it needs a real browser window for first-time login).
- Dashboard runs on the user's laptop, with `NEXT_PUBLIC_AGENT_URL` pointing at the Brev secure-link URL for port 8000.

No Dockerfile or systemd unit ships in this release. PM2 or `nohup npm start` is enough for the demo; persistent process management is a follow-up.

## Troubleshooting

- **Onboarding stalls on "Analyzing..."** — Check that the agent is running and that `NIM_API_KEY` is set in `agent/.env`. The agent logs every NIM call; failures show the exact NVIDIA error.
- **Login window does not open** — The sidecar must be running on the same machine as the browser. Visit <http://localhost:9000/health> to confirm.
- **Comments stop appearing** — Look at the agent's logs for `tick failed`. Reddit rate-limits aggressive User-Agents; keep `USER_AGENT` identifiable.
- **Dashboard shows "Agent unreachable"** — Confirm `NEXT_PUBLIC_AGENT_URL` matches where the agent is actually listening. On Brev, that is the secure-link URL, not `http://localhost`.
- **CHECK constraint failed on `posts.platform`** — You upgraded an existing DB but the agent did not restart. The new boot runs an automatic in-place rebuild of the posts table to widen the CHECK; restart and retry.

## License

No license file in this release. Treat this as a hackathon artifact: read it, learn from it, fork it, but ask before reusing in a commercial product.
