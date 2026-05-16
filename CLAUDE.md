

## Project Overview
Pincer is a 24-hour NVIDIA hackathon project — an autonomous multi-platform launch agent for indie hackers. It drafts platform-tailored posts, publishes to Reddit + Discord, polls comments on a 60s loop, classifies them, and surfaces hard ones to a human-review inbox. Built on OpenClaw + NVIDIA Nemotron 3 (Super for drafting, Nano for classification), wrapped in NemoClaw's OpenShell sandbox for the bonus track.

## Tech Stack

### Runtime & language

- Node.js 22+
- TypeScript

### Agent

- OpenClaw (agent framework, AgentSkills format)
- NVIDIA NIM at integrate.api.nvidia.com (OpenAI-compatible API)
  - Nemotron 3 Super 120B — post drafting & suggested replies
  - Nemotron 3 Nano — comment classification
- OpenAI SDK (used as the NIM client)

### Dashboard

- Next.js 16 (App Router, server components)
- recharts — analytics charts

### Data

- SQLite via better-sqlite3 (single file, ./data.db)

### Platform integrations

All platform interactions go through a Python sidecar wrapping [browser-harness](https://github.com/browser-use/browser-harness), which drives a real Chrome via CDP. No per-platform API libraries (no snoowrap, no discord.js, no Twitter SDK). Per-platform behavior lives in `agent/src/platforms/<name>.ts` as task strings handed to the sidecar.

- browser-harness (Python) — single mechanism for Reddit / X / Discord / Instagram / TikTok / HN
- Browser Use Cloud (optional) — hosted stealth browsers + captcha solving on the free tier

### Deployment & sandbox

- Brev launchable (cloud track host)
- NemoClaw / OpenShell — egress-policy sandbox (bonus track)

## Architecture

Split deployment with three processes:

- **Next.js dashboard** (runs on the user's laptop) — owns the UI. Onboarding wizard, compose/approve flow, escalation inbox, analytics. Stateless; reads everything from the agent over HTTP.
- **OpenClaw agent** (Node.js, runs on Brev) — owns the loop and the SQLite DB. Drafts posts via Nemotron Super, orchestrates the browser via the sidecar, polls comments every 60s, classifies them via Nemotron Nano, writes escalations.
- **Browser sidecar** (Python + browser-harness, runs on Brev next to the agent) — drives a real Chrome via CDP. Receives natural-language tasks from the agent ("post this to r/test", "fetch comments on t3_abc") and returns structured results + updated session cookies.

The agent + sidecar are wrapped by NemoClaw with an egress allowlist (platform domains + `integrate.api.nvidia.com` + optionally `cloud.browser-use.com`). SQLite was chosen over Postgres because a single-host single-writer demo has no concurrency concerns and the single-file backup is trivial. NIM was chosen over local Ollama because the hackathon is the Cloud track and NIM removes the "did the model load" failure mode from the demo. browser-harness was chosen over per-platform API libraries because it gives one uniform mechanism for every platform (Reddit, X, Instagram, TikTok, HN), most of which gate their APIs behind business approval or have no API at all.

See [PLAN.md](PLAN.md) for the full architecture diagram, database schema, skill list, and 24-hour schedule.

## General Rules
- Use kebab case for naming files
- Write lots of comments to help me understand the code.

## Coding Rules
- Use functional React components
- Prefer server components
- Use Tailwind utilities instead of custom CSS

## Design Rules
- We want a clean simple design
- use responsive design to account for all screen sizes

## Commands

-

# Command Guard
Print the following before running commands

[READ-ONLY] — just looking, no harm done
[MUTATION] — changes things, but recoverable
[DESTRUCTIVE] — irreversible, think twice
[SYSTEM] — touching system-level stuff like packages and permissions

