

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

- snoowrap — Reddit submit + comment polling
- discord.js — Discord send + comment polling
- hn.algolia.com — Hacker News read-only (analytics only; posting deferred to v1)

### Deployment & sandbox

- Brev launchable (cloud track host)
- NemoClaw / OpenShell — egress-policy sandbox (bonus track)

## Architecture

Two long-running processes share one SQLite file:

- **OpenClaw agent** (Node.js) — owns the loop. Drafts posts via Nemotron Super, posts to Reddit/Discord, polls comments every 60s, classifies them via Nemotron Nano, writes escalations.
- **Next.js dashboard** — owns the UI. Onboarding wizard, compose/approve flow, escalation inbox, analytics.

Both processes are wrapped by NemoClaw with an egress allowlist (`api.reddit.com`, `discord.com`, `hn.algolia.com`, `integrate.api.nvidia.com`). SQLite was chosen over Postgres because a 24-hour single-host demo has no concurrency concerns and the single-file backup is trivial. NIM was chosen over local Ollama because the hackathon is the Cloud track and NIM removes the "did the model load" failure mode from the demo.

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

