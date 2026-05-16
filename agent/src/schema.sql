-- Pincer agent schema. Executed once at startup by db.ts via db.exec().
--
-- Tables:
--   posts       — one row per registered Reddit/HN/Bluesky post we want to track.
--   snapshots   — append-only time series of (score, comment_count) per post.
--   comments    — every distinct comment we've seen on a watched post.
--
-- Design notes:
--   * `external_id` is the platform's own ID (Reddit's "1abc23", HN's numeric
--     item id, Bluesky's full AT URI `at://did:.../app.bsky.feed.post/<rkey>`).
--     The (platform, external_id) UNIQUE constraint guarantees we never
--     double-register the same post.
--   * `watch_enabled` toggles whether the watch loop polls this post. Posts
--     stay in the DB when paused so we keep the history visible in the UI.
--   * `source` records how the row got here — useful for analytics and for
--     the future "watch your old posts?" backfill question in onboarding.
--   * Snapshot and comment children CASCADE on delete: removing a post takes
--     its history with it. ON DELETE CASCADE requires PRAGMA foreign_keys=ON,
--     which db.ts sets at connection time.
--   * `posted_at`/`fetched_at` are unix epoch seconds (INTEGER). SQLite's
--     `unixepoch()` is the default for fresh rows; the watch loop passes
--     explicit timestamps when re-importing comment metadata.

CREATE TABLE IF NOT EXISTS posts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT    NOT NULL CHECK (platform IN ('reddit','hn','bluesky')),
  external_id   TEXT    NOT NULL,
  permalink     TEXT    NOT NULL,
  title         TEXT,
  body          TEXT,
  author        TEXT,
  posted_at     INTEGER,
  watch_enabled INTEGER NOT NULL DEFAULT 1,
  source        TEXT    NOT NULL DEFAULT 'manual'
                          CHECK (source IN ('published','backfill','manual')),
  created_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (platform, external_id)
);

CREATE TABLE IF NOT EXISTS snapshots (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id       INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  fetched_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  score         INTEGER NOT NULL,
  comment_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_snap_post_time ON snapshots(post_id, fetched_at DESC);

CREATE TABLE IF NOT EXISTS comments (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id             INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  external_id         TEXT    NOT NULL,
  author              TEXT,
  body                TEXT,
  posted_at           INTEGER,
  fetched_at          INTEGER NOT NULL DEFAULT (unixepoch()),
  -- Per-comment score. Reddit returns a real value; HN doesn't surface it,
  -- so HN rows always store NULL. Bluesky stores the reply's likeCount.
  -- Treat NULL as "unknown", not "zero".
  score               INTEGER,
  -- Parent comment's external_id. NULL when the comment is a top-level
  -- reply to the post itself. Enables future threading reconstruction
  -- without changing how we DFS-flatten on insert.
  parent_external_id  TEXT,
  UNIQUE (post_id, external_id)
);
CREATE INDEX IF NOT EXISTS idx_comments_post_posted ON comments(post_id, posted_at DESC);

-- Project context captured during onboarding. Stores the user's repo URL,
-- a Nemotron-generated structured ProjectDocumentation blob, a typed list
-- of clarifying questions Nemotron asked, and the user's answers. The
-- reply route reads these into the prompt so drafted replies stay
-- grounded in the user's actual project.
CREATE TABLE IF NOT EXISTS project_context (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),  -- singleton row
  repo_url           TEXT,
  documentation_json TEXT,  -- structured ProjectDocumentation JSON
  questions_json     TEXT,  -- typed ProjectQuestion[] JSON
  answers_json       TEXT,  -- ProjectAnswer[] keyed by question id
  updated_at         INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Single-table key/value store for agent-wide knobs the user can tweak
-- from the dashboard's Settings page. Values are stored as TEXT and
-- parsed at read time (settings.ts handles the casts). Two settings exist
-- today:
--   base_poll_interval_seconds  — scheduler period. Posts under 1h old
--                                 are polled every Nth tick (multiplier 1).
--   adaptive_polling_enabled    — '1' or '0'. When 0, every post polls at
--                                 the base interval regardless of age.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
