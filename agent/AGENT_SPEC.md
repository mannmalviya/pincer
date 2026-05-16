# Pincer agent — implementation spec

A self-contained behavioral spec for the Pincer agent. The current
implementation under `agent/src/` is Node 22 + Fastify + better-sqlite3,
but this document describes the *contract*, not the implementation, so a
re-implementation in any stack can be verified against it.

Goal: a long-running service that scrapes Reddit + HN posts on a 60s
schedule, persists snapshots and comments to SQLite, exposes an HTTP API
the Next.js dashboard reads from, and uses NVIDIA NIM (Nemotron Super)
for two LLM features — reply drafting and onboarding repo analysis.

## Network layout

```
[Dashboard on laptop]              [Agent on Brev]
   localhost:3000     ──HTTPS─►    0.0.0.0:8000 (this service)
                                      │
                                      ├──► reddit.com (.json public API)
                                      ├──► hacker-news.firebaseio.com (HN v0)
                                      ├──► hn.algolia.com (HN search)
                                      ├──► integrate.api.nvidia.com (NIM)
                                      └──► github.com (clone during onboarding)
```

Bind: `HOST=0.0.0.0`, `PORT=8000`. CORS: allow any `localhost` /
`127.0.0.1` origin on http or https.

## Environment

Required for full functionality (the agent should boot and serve
non-LLM routes without them, returning 503 from LLM routes when
unconfigured):

- `NIM_API_KEY` — NVIDIA NIM key. Without it `/comments/:id/draft-reply`
  and `/onboarding/analyze` return 503.
- `NIM_BASE_URL` — defaults to `https://integrate.api.nvidia.com/v1`.
- `NIM_REPLY_MODEL` — defaults to
  `nvidia/llama-3.3-nemotron-super-49b-v1`. Used for both reply drafting
  and onboarding analysis.
- `USER_AGENT` — sent on every outbound Reddit/HN request. Reddit bans
  generic UAs; use something identifiable like
  `pincer-agent/0.1 (+contact)`.
- `DB_PATH` — SQLite file location. Default `./agent.sqlite`.
- `WATCH_INTERVAL_MS` — scheduler period default in ms. Settings table
  overrides at runtime.

## Data model (SQLite)

```sql
CREATE TABLE posts (
  id            INTEGER PRIMARY KEY,
  platform      TEXT NOT NULL CHECK (platform IN ('reddit','hn')),
  external_id   TEXT NOT NULL,         -- Reddit "1abc23", HN "42"
  permalink     TEXT NOT NULL,
  title         TEXT,
  body          TEXT,                  -- selftext / story text
  author        TEXT,
  posted_at     INTEGER,               -- unix seconds
  watch_enabled INTEGER NOT NULL DEFAULT 1,
  source        TEXT NOT NULL DEFAULT 'manual'
                  CHECK (source IN ('published','backfill','manual')),
  created_at    INTEGER NOT NULL,
  UNIQUE (platform, external_id)
);

CREATE TABLE snapshots (
  id            INTEGER PRIMARY KEY,
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  fetched_at    INTEGER NOT NULL,
  score         INTEGER NOT NULL,      -- 0 if platform omits
  comment_count INTEGER NOT NULL
);

CREATE TABLE comments (
  id                  INTEGER PRIMARY KEY,
  post_id             INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  external_id         TEXT NOT NULL,
  author              TEXT,
  body                TEXT,
  posted_at           INTEGER,
  fetched_at          INTEGER NOT NULL,
  score               INTEGER,              -- Reddit only; HN is NULL
  parent_external_id  TEXT,                 -- NULL for top-level
  UNIQUE (post_id, external_id)
);

CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE project_context (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  repo_url    TEXT,
  summary     TEXT,
  qa_json     TEXT,  -- JSON array of {question, answer}
  updated_at  INTEGER NOT NULL
);
```

`PRAGMA foreign_keys = ON` + `PRAGMA journal_mode = WAL`.

## HTTP API

All responses are JSON. Errors return
`{ "error": { "code": "<slug>", "message": "<human>" } }` with an
appropriate status code.

### Health

`GET /health` → `{ "ok": true, "ts": <unix-ms> }`. No-op, used by the
dashboard's live status indicator.

### Posts

`POST /posts` — register a URL for watching.
- Body: `{ url, watch?: bool, source?: 'published'|'backfill'|'manual' }`
- Behavior: parse the URL → fetch initial data from platform → `INSERT`
  the post → run one tick (snapshot + comments). If `(platform,
  external_id)` already exists, return the existing row with
  `duplicate: true` instead of 409. Always run the tick (refresh).
- Response: `{ post, snapshot, comments_inserted, duplicate }`.
- 400 on unparseable URL.

`GET /posts` — list all posts with latest snapshot inlined:
`{ posts: [{ ...post, latest_snapshot: { fetched_at, score, comment_count } | null }] }`,
ordered by `posts.created_at DESC`.

`GET /posts/:id` — single post + full history:
`{ post, snapshots: [...], comments: [...] }`, both ordered newest-first.

`PATCH /posts/:id` — body `{ watch_enabled: bool }`. Returns `{ post }`.

`DELETE /posts/:id` — `{ deleted: true }`. FK cascades wipe child rows.

### Stats

`GET /stats` →
`{ posts_total, posts_watching, pending_replies, comments_tracked }`.
All counters from the DB. `pending_replies` is `0` for now.

### Comments feed

`GET /comments?limit=N` (default 50, max 200) →
`{ comments: [{ id, external_id, author, body, posted_at, fetched_at, score, parent_external_id, post_id, platform, post_title, post_permalink }] }`,
ordered by `COALESCE(posted_at, fetched_at) DESC`. Joins `comments` with
`posts` so each row carries the post context inline.

### Reply drafting (NIM)

`POST /comments/:id/draft-reply` →
`{ draft, model }` or
`{ error: { code: 'nim_not_configured' | 'http_error' | 'network_error' | ... } }`
(503 / 502 / 500).
Reads the comment + parent post + (if present) the project_context
summary and Q/A, sends them to Nemotron with a system prompt that
constrains tone (first-person, no marketing fluff, 2-4 sentences,
no emojis, never invent facts).

### Onboarding (repo analysis)

`POST /onboarding/analyze` — body `{ repo_url, token? }`.
- Parses a GitHub HTTPS repo URL and fetches its README through the GitHub
  REST API. Optional PAT is sent as a bearer token for private repos.
- Sends the README to Nemotron with instructions to return structured
  project documentation plus clarifying questions.
- Persists the result on `project_context` (singleton row id=1).
- Response: `{ documentation, questions }`.
- GitHub fetch failures return `github_fetch_failed`; responses must not echo
  the PAT.

`POST /onboarding/answers` — body `{ answers: [{ question, answer }] }`.
Persists onto `project_context.qa_json`. Returns the updated context.

`GET /onboarding/context` →
`{ repo_url, summary, qa, updated_at }`.

### Backfill by user

`POST /backfill-user` — body `{ platform: 'reddit'|'hn', username, watch?: bool }`.
- Reddit: `GET https://www.reddit.com/user/{name}/submitted.json?limit=100&raw_json=1&sort=new`,
  filter `kind === 't3'`, map each id to `https://www.reddit.com/comments/{id}`.
- HN: `GET https://hn.algolia.com/api/v1/search_by_date?author={name}&tags=story&hitsPerPage=1000`,
  map `objectID` to `https://news.ycombinator.com/item?id={id}`.
- For each discovered URL, register via the same logic as `POST /posts`
  (sequential, source=`backfill`).
- Response: `{ platform, username, found, added, duplicates, errors: [{url, message}] }`.

### Settings

`GET /settings` →
`{ base_poll_interval_seconds, adaptive_polling_enabled }`.

`PATCH /settings` — body with optional same keys. Validates
`base_poll_interval_seconds` in `[30, 3600]`. Re-applies the watch
loop's timer immediately so a changed interval takes effect without a
process restart.

## Watch loop

A long-running scheduler that re-fetches every watched post and writes
a new snapshot + any new comments.

Period: `base_poll_interval_seconds` from settings (default 60s).
Reentry guard: if a tick is still running when the next interval fires,
skip — don't overlap.

Per-post adaptive due-time. When `adaptive_polling_enabled = 1`, the
effective interval per post is `base * multiplier(age)`:

| Age of post           | Multiplier |
|-----------------------|-----------:|
| < 1 hour              | 1          |
| 1h – 24h              | 2          |
| 1d – 7d               | 10         |
| 7d – 30d              | 60         |
| ≥ 30d                 | 360        |

Each scheduler tick:
1. `SELECT * FROM posts WHERE watch_enabled = 1` with each post's most
   recent snapshot timestamp (subquery on `snapshots`).
2. For each post, compute due-time: `(now - last_fetched_at) >= base *
   multiplier(now - posted_at)`. Skip if not due.
3. For due posts, in sequence (not parallel — keep Reddit/HN happy):
   - Fetch from platform.
   - Insert one snapshot row.
   - `INSERT OR IGNORE` every comment (UNIQUE on
     `(post_id, external_id)` dedupes).

## Platform fetchers

### Reddit

- Post + comments: `GET https://www.reddit.com/comments/{id}.json?raw_json=1&limit=500`
  - User-Agent header required.
  - Response is `[postListing, commentsListing]`.
  - Post: `postListing.data.children[0].data` (`title`, `selftext`,
    `author`, `created_utc`, `score`, `num_comments`, `permalink`).
  - Comments: DFS-flatten `commentsListing.data.children`, filter
    `kind === 't1'`. Capture `score`, `body`, `author`, `created_utc`,
    `id`. Thread `parent_external_id` through recursion. Skip `kind:
    "more"` placeholders.

### HN

- Item: `GET https://hacker-news.firebaseio.com/v0/item/{id}.json`.
  Returns `{ id, by, time, title, text, score, descendants, kids }`.
  Skip `dead` or `deleted` items.
- Top-level comments: `Promise.all` over `kids`, one fetch each.
  `score` is always `null` on HN, `parent_external_id` always `null`
  (no nested replies in this iteration).
- `comment_count` uses `descendants` (total including nested) even
  though we only store top-level bodies.

## NIM

OpenAI-compatible HTTP. `POST {NIM_BASE_URL}/chat/completions` with
`Authorization: Bearer {NIM_API_KEY}` and a body like:

```json
{
  "model": "nvidia/llama-3.3-nemotron-super-49b-v1",
  "messages": [{"role":"system","content":"..."},
               {"role":"user","content":"..."}],
  "temperature": 0.4,
  "max_tokens": 400
}
```

Response is OpenAI shape; read `choices[0].message.content`.

## Acceptance test (e2e)

A re-implementation passes if every step here works end-to-end against
a running instance bound at `http://127.0.0.1:8000`. The Pincer
dashboard at `localhost:3000` (set `NEXT_PUBLIC_AGENT_URL`) should
function unchanged.

```bash
# 1. Health
curl -s http://127.0.0.1:8000/health | jq .ok   # → true

# 2. Register a real Reddit post
curl -s -X POST http://127.0.0.1:8000/posts \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.reddit.com/r/SideProject/comments/REAL_ID","source":"backfill"}' \
  | jq '{id: .post.id, score: .snapshot.score, ci: .comments_inserted}'

# 3. Re-register the same URL → duplicate:true, same id
curl -s -X POST http://127.0.0.1:8000/posts \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.reddit.com/r/SideProject/comments/REAL_ID","source":"backfill"}' \
  | jq .duplicate                                # → true

# 4. List posts
curl -s http://127.0.0.1:8000/posts | jq '.posts | length'   # ≥ 1

# 5. Stats
curl -s http://127.0.0.1:8000/stats
# → { posts_total: ≥1, posts_watching: ≥1, pending_replies: 0, comments_tracked: N }

# 6. Comments feed
curl -s 'http://127.0.0.1:8000/comments?limit=5' | jq '.comments[0].platform'

# 7. Settings round-trip
curl -s -X PATCH http://127.0.0.1:8000/settings \
  -H 'content-type: application/json' \
  -d '{"base_poll_interval_seconds":120,"adaptive_polling_enabled":true}'
# → echoes new values; watch loop re-schedules without restart

# 8. Reply drafting (requires NIM_API_KEY)
curl -s -X POST http://127.0.0.1:8000/comments/1/draft-reply
# → { draft, model } or { error: { code: 'nim_not_configured' } } if no key

# 9. Onboarding analyze (requires NIM_API_KEY)
curl -s -X POST http://127.0.0.1:8000/onboarding/analyze \
  -H 'content-type: application/json' \
  -d '{"repo_url":"https://github.com/mannmalviya/pincer"}'
# → { summary: "...", questions: [4-6 items] }

# 10. Watch loop progression: wait one scheduler period, check that a
# new snapshot row exists for post 1.
sleep 120
sqlite3 ~/.pincer/agent.sqlite \
  "SELECT count(*) FROM snapshots WHERE post_id = 1;"
# Expect ≥ 2.
```

Behavioral checks beyond the API:
- Killing the process with SIGINT should flush WAL and exit cleanly.
- Restarting picks up watched posts from SQLite and continues without
  re-registration.
- An unreachable network (no Reddit, no NIM) must not crash the loop —
  individual ticks log + continue; the next tick retries.
- The PAT passed to `/onboarding/analyze` must not appear in any HTTP
  response body, log line, or error message.

## Out of scope

- Auth on the agent's HTTP routes. Single-user demo; rely on the host
  firewall / sandbox.
- Posting to Reddit/HN — that lives in the Python `browser-sidecar`
  process on the operator's laptop and is unrelated to this agent.
- Per-comment HN scores (HN's API doesn't expose them).
- Nested HN replies (out of scope for v1).
- Real-time push (SSE/WebSocket). Dashboard polls.
