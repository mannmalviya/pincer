# Pincer agent

Persistent backend for Pincer. Owns the SQLite DB; runs a 60-second loop that
re-fetches every watched Reddit / Hacker News post and records score, comment
count, and any new comments. Exposes an HTTP API the dashboard talks to.

## Quick start

```bash
npm install
npm run dev
```

Agent listens on `127.0.0.1:8000`. First boot creates `agent.sqlite` in the
working directory and runs the schema.

Smoke test:

```bash
# liveness
curl http://localhost:8000/health

# register a real Reddit post for watching
curl -X POST http://localhost:8000/posts \
  -H 'content-type: application/json' \
  -d '{"url":"https://www.reddit.com/r/SideProject/comments/<live-id>/","source":"backfill"}'

# register a HN post
curl -X POST http://localhost:8000/posts \
  -H 'content-type: application/json' \
  -d '{"url":"https://news.ycombinator.com/item?id=<live-id>","source":"backfill"}'

# what are we tracking?
curl http://localhost:8000/posts

# overview counts (for the dashboard cards)
curl http://localhost:8000/stats

# pause watching one post
curl -X PATCH http://localhost:8000/posts/1 \
  -H 'content-type: application/json' -d '{"watch_enabled":false}'

# unregister a post (cascades to its snapshots + comments)
curl -X DELETE http://localhost:8000/posts/2
```

## Configuration

All knobs are env vars with sensible defaults. Override in `.env` for dev or
in your launchable's environment for prod.

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8000` | HTTP listen port |
| `DB_PATH` | `./agent.sqlite` | SQLite file path |
| `WATCH_INTERVAL_MS` | `60000` | Watch loop interval |
| `USER_AGENT` | `pincer-agent/0.1 (+...)` | Sent to Reddit + HN. Generic UAs get 429'd by Reddit; keep this identifiable. |

## Architecture

```
src/
  index.ts          entrypoint: DB init, server start, loop start, shutdown
  server.ts         Fastify factory; CORS, error handler, route registration
  config.ts         env-driven knobs
  db.ts             better-sqlite3 singleton + schema migration
  schema.sql        DDL (executed once at startup)
  types.ts          Post / Snapshot / Comment shapes shared across modules
  routes/
    health.ts       GET /health
    posts.ts        POST/GET/PATCH/DELETE /posts(/:id)
    stats.ts        GET /stats
  platforms/
    parse.ts        URL string → { platform, externalId }
    reddit.ts       Reddit public .json fetcher
    hn.ts           HN Firebase v0 fetcher
    index.ts        dispatch
  watch/
    loop.ts         setInterval driver with reentry guard
    tick.ts         one-post: fetch → insert snapshot → diff comments
  lib/
    http.ts         fetch wrapper (User-Agent, timeout, JSON typed)
    log.ts          minimal level-prefixed logger
    row-mappers.ts  SQLite row → typed object
```

## What's NOT in this iteration

- Comment classification (Nemotron Nano via NIM).
- Escalation queue for human review.
- SSE push to the dashboard. The dashboard polls `/posts` and `/stats`.
- Authentication. The agent binds 127.0.0.1 only.
- Reddit OAuth. The public `.json` endpoint covers our volume.
- HN nested replies. Top-level comments only.
- Brev deployment artifacts (Dockerfile, systemd, env management).

Each lives in its own follow-up pass; the file layout has the obvious slots.
