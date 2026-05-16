# Pincer — Hackathon v0

> *Pincer gets a grip on your launch.* Multi-platform launch agent built on OpenClaw — the claw motif is intentional and free brand equity for the demo.

## Context

24-hour NVIDIA hackathon (Cloud + NemoClaw bonus track). **Pincer** is an autonomous marketing agent for indie hackers / project launchers: it generates platform-tailored posts, posts them to Reddit + Discord, monitors comments, surfaces hard ones to a human via a dashboard inbox, and tracks analytics. Powered by OpenClaw (Node.js agent framework by Peter Steinberger) + NVIDIA Nemotron 3 Super, deployed on a Brev launchable, wrapped in NemoClaw's OpenShell sandbox for the bonus prize track.

**Why this scope:** the original "post + comment-loop + escalation" workflow is the actual painful part of launch marketing — 30 min of posting + days of comment babysitting. Removing comment monitoring would gut the demo. Auto-replies were dropped because a hallucinated bot reply on a real subreddit during the live demo would torpedo the judging.

**HN is intentionally deferred** — no official write API, and the user noted Browser Harness (browser-automation project) can plug in later. v0 ships HN read-only via Algolia API for analytics; posting is a clearly-shaped extension point.

## Architecture

Two long-running processes sharing one SQLite database, both wrapped by NemoClaw:

```
┌─────────────────────────┐     ┌──────────────────────────┐
│  OpenClaw Agent (Node)  │     │  Next.js Dashboard       │
│  - Custom skills        │     │  - Onboarding wizard     │
│  - Polls comments       │◄────┤  - Compose / approve     │
│  - Classifies + posts   │     │  - Live analytics        │
│  - Calls Nemotron NIM   │     │  - Escalation inbox      │
└────────┬────────────────┘     └────────────┬─────────────┘
         │                                   │
         └─────────► SQLite (./data.db) ◄────┘
                (posts, comments, escalations,
                 analytics_snapshots, accounts)

         All wrapped in NemoClaw / OpenShell sandbox.
         Egress policy: api.reddit.com, discord.com,
         hn.algolia.com, integrate.api.nvidia.com.
```

**Why two processes, one SQLite:** OpenClaw owns the agent loop; Next.js owns the UI. SQLite (better-sqlite3) is fine for a 24h demo — no concurrency hell, single file, trivial backup. Skip Postgres.

**Why NIM not local Ollama:** Cloud track. NIM at `integrate.api.nvidia.com` is OpenAI-compatible, free during preview, and removes the "did the model load" failure mode from the demo. Nemotron 3 Super 120B for the headline; fall back to Nemotron 3 Nano for the cheap classification step (FAQ vs needs-human).

**Why NemoClaw on top:** bonus track. The egress policy YAML is the demo artifact — show judges that the agent is constrained to four hosts and any drift triggers a TUI approval prompt.

## File structure

```
pincer/
├── agent/                          # OpenClaw agent (Node.js 22+)
│   ├── openclaw.json               # agent config: skills allowlist, model = nemotron-3-super
│   ├── src/
│   │   ├── loop.ts                 # main poll loop (every 60s)
│   │   ├── nemotron.ts             # NIM client (OpenAI-compat SDK, base_url=integrate.api.nvidia.com)
│   │   ├── db.ts                   # better-sqlite3 wrapper
│   │   └── platforms/
│   │       ├── reddit.ts           # snoowrap wrapper
│   │       ├── discord.ts          # discord.js wrapper
│   │       └── hn.ts               # hn.algolia.com fetch (read-only v0)
│   └── skills/                     # SKILL.md folders, AgentSkills format
│       ├── generate-post/SKILL.md          # platform-tailored post drafting
│       ├── post-to-reddit/SKILL.md         # wraps platforms/reddit.ts submit
│       ├── post-to-discord/SKILL.md        # wraps platforms/discord.ts send
│       ├── poll-comments/SKILL.md          # pulls new comments since last cursor
│       ├── classify-comment/SKILL.md       # FAQ / needs-human / spam (cheap Nano call)
│       └── escalate-to-human/SKILL.md      # writes row to escalations table
│
├── dashboard/                      # Next.js 16 App Router
│   ├── app/
│   │   ├── onboarding/page.tsx     # first-run wizard: paste Reddit/Discord tokens
│   │   ├── compose/page.tsx        # textarea → "draft posts" → per-platform preview → approve/post
│   │   ├── inbox/page.tsx          # escalations list, one-click reply (sends back through agent)
│   │   ├── analytics/page.tsx      # recharts: views, upvotes, comments-over-time per platform
│   │   └── api/                    # /api/accounts, /api/posts, /api/escalations/[id]/reply
│   └── lib/db.ts                   # shared better-sqlite3 handle (read-mostly)
│
├── policies/
│   └── nemoclaw.yaml               # egress allowlist, demo artifact
├── data.db                         # SQLite, gitignored
└── README.md                       # 5-step setup the judges can run
```

## Database schema (SQLite)

```sql
accounts(id, platform, handle, token_encrypted, created_at)
posts(id, content_md, created_at, status)              -- one logical "launch", many platform_posts
platform_posts(id, post_id, platform, external_id, posted_at, raw_url)
comments(id, platform_post_id, external_id, author, body, created_at, classification)
                                          -- classification: 'faq'|'needs_human'|'spam'|null
escalations(id, comment_id, status, suggested_reply, human_reply, resolved_at)
                                          -- status: 'pending'|'replied'|'dismissed'
analytics_snapshots(id, platform_post_id, captured_at, upvotes, views, comment_count)
```

## Skills to build (6 total)

Each is a directory with `SKILL.md` (YAML frontmatter + natural-language instructions per OpenClaw spec). The skill body tells Nemotron how/when to invoke the underlying TS function exposed via the OpenClaw plugin loader.

| Skill | Reuses | Purpose |
|---|---|---|
| `generate-post` | `nemotron.ts` | One product brief in → N platform-specific drafts out. Reddit = problem-first, Discord = casual + emoji, HN = blunt title. |
| `post-to-reddit` | `platforms/reddit.ts` (snoowrap) | Submit + persist `platform_posts` row + URL. |
| `post-to-discord` | `platforms/discord.ts` (discord.js) | Send to configured channel + persist. |
| `poll-comments` | all `platforms/*.ts` | Per-platform cursor-based pull, dedupe on `external_id`, insert into `comments`. |
| `classify-comment` | `nemotron.ts` (Nano) | Returns one of `faq` / `needs_human` / `spam`. Cheap call so we can run it on every new comment. |
| `escalate-to-human` | `db.ts` | If `needs_human`, draft a tentative reply with Nemotron Super, write `escalations` row. Dashboard inbox picks it up. |

## 24-hour schedule

Time-boxed. If a phase runs over, drop the listed cut-line items, not the next phase.

| Hours | Milestone | Cut-line if behind |
|---|---|---|
| 0-1 | Brev launchable up. NemoClaw installed (`curl … nemoclaw.sh`). NIM API key in env. Repo skeleton + db schema. | — |
| 1-3 | `nemotron.ts` calling NIM works. `platforms/reddit.ts` + `platforms/discord.ts` can post via test bot accounts. | — |
| 3-6 | OpenClaw agent runs the 3 skills `generate-post` → `post-to-reddit` → `post-to-discord` end-to-end from CLI. | — |
| 6-10 | Next.js dashboard: onboarding wizard + compose page. "Draft posts" button hits agent over a thin HTTP shim. | Drop onboarding wizard, hardcode tokens in `.env`. |
| 10-14 | `poll-comments` skill + comment loop running on 60s timer. Comments visible in dashboard. | — |
| 14-18 | `classify-comment` + `escalate-to-human`. Inbox page renders pending escalations with one-click reply. | Drop suggested-reply drafting, just surface raw comment. |
| 18-21 | Analytics page (recharts), `analytics_snapshots` populated every 5 min. HN read-only via Algolia. | Drop HN entirely; Reddit + Discord only. |
| 21-23 | NemoClaw policy YAML locked down to 4 hosts. Verify the TUI approval prompt fires when you try to curl elsewhere — this is the bonus-track demo moment. | Drop NemoClaw, accept losing bonus track. |
| 23-24 | Demo script rehearsal. README. Submission video. | — |

## Critical files to create/modify

- [agent/openclaw.json](agent/openclaw.json) — sets agent name, model `nemotron-3-super`, skills allowlist
- [agent/src/nemotron.ts](agent/src/nemotron.ts) — OpenAI SDK pointed at `https://integrate.api.nvidia.com/v1`, two helpers: `super()` and `nano()`
- [agent/src/loop.ts](agent/src/loop.ts) — `setInterval(60_000)` calling `poll-comments` then `classify-comment` for each new row
- [agent/src/db.ts](agent/src/db.ts) — single better-sqlite3 connection, prepared statements for the 6 tables
- [agent/skills/*/SKILL.md](agent/skills/) — 6 skill files, AgentSkills YAML-frontmatter format
- [dashboard/app/inbox/page.tsx](dashboard/app/inbox/page.tsx) — server component reading `escalations where status='pending'`
- [dashboard/app/compose/page.tsx](dashboard/app/compose/page.tsx) — POST to `/api/draft` returns N platform drafts; "Approve & post all" calls `/api/post`
- [policies/nemoclaw.yaml](policies/nemoclaw.yaml) — egress allowlist, demo artifact

## Verification

End-to-end demo run (also the script for the submission video):

1. Fresh Brev box. Run `curl … nemoclaw.sh | bash`, accept defaults, pick `nemotron-3-super` via NIM.
2. `cd pincer && npm install && npm run db:init && npm run dev` (boots agent + dashboard).
3. Open dashboard → Onboarding → paste Reddit script-app credentials + Discord bot token + channel ID. Test ping each.
4. Compose page → paste a 3-line product brief ("We just launched FooLint, a TypeScript linter for…"). Click **Draft posts**. Three platform-specific drafts render side-by-side. Edit the Reddit one. Click **Approve & post all**.
5. Within seconds, the Reddit URL and Discord message link render on the page.
6. Have a teammate comment on the Reddit post with both an FAQ-style question ("Is it free?") and a hard one ("How does this compare to Biome's quirks-mode?"). Wait ≤60s.
7. Inbox tab shows one pending escalation (the hard one) with a Nemotron-drafted suggested reply. Click **Edit & send** → reply appears on Reddit.
8. Analytics tab: chart shows comment-count growing.
9. **NemoClaw bonus moment:** in another terminal inside the sandbox, `curl https://example.com`. The OpenShell TUI prompts for approval. Deny it. Show judges `policies/nemoclaw.yaml` — only 4 hosts allowed.

## Out of scope for v0 (mention in README as v1+)

- AI video generation
- HN posting (browser automation pluggable later via Browser Harness)
- Multi-user / auth on dashboard
- Auto-replies (only suggested replies + human approve)
- Sentiment analysis charts
- Cross-post deduplication / scheduling

## Risks

1. **Reddit bot account ban.** Brand-new accounts posting to popular subs get auto-removed. Demo against `r/test` or a sub the team mods. Onboarding wizard explicitly tells the user this.
2. **NIM rate limits.** Free preview tier may throttle. Have an Ollama-on-Brev fallback ready: `OLLAMA_BASE_URL` env switch in `nemotron.ts`.
3. **NemoClaw setup eats too long.** It's early-preview software. Hard time-box it to the 21-23h slot; if it doesn't work, ship without and skip the bonus track.
4. **Discord bot needs server invite link before demo.** Add to onboarding wizard checklist with the OAuth URL pre-built.
