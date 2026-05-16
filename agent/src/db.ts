// SQLite handle for the agent. Singleton: one database connection per
// process. better-sqlite3 is synchronous (the connection is just a libsqlite
// handle) which means every query blocks the event loop briefly, but at
// sub-millisecond costs for our query shapes that's a non-issue and is
// dramatically simpler than node-sqlite3's async model.

import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DB_PATH } from "./config.js";
import { log } from "./lib/log.js";

// __dirname analog for ES modules. We need it to locate schema.sql at
// runtime: it lives next to this source file in src/, and after tsc build
// it gets emitted alongside this compiled module in dist/. We treat the
// SQL file as a runtime asset and read it on demand.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Module-level singleton. Calling getDb() from anywhere returns the same
// connection. We export the handle indirectly through getDb() so we can
// run the schema migration the first time it's accessed.
let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db !== null) return _db;

  log.info("opening sqlite database", { path: DB_PATH });
  _db = new Database(DB_PATH);

  // WAL mode lets concurrent readers (HTTP handlers) proceed while the
  // watch loop is mid-write. Without it, every read blocks behind any
  // open write transaction.
  _db.pragma("journal_mode = WAL");

  // Foreign keys are OFF by default in SQLite (legacy behavior). We need
  // them ON so ON DELETE CASCADE on snapshots/comments actually fires
  // when a post is deleted.
  _db.pragma("foreign_keys = ON");

  // Run the schema. CREATE TABLE IF NOT EXISTS makes this idempotent —
  // every boot re-applies the schema, which is fine while we're not yet
  // doing real migrations. When the schema starts evolving past this
  // initial cut, swap in a user_version-based migrations runner.
  const schemaPath = resolve(__dirname, "schema.sql");
  const schemaSql = readFileSync(schemaPath, "utf-8");
  _db.exec(schemaSql);

  // Lightweight in-place migrations for already-deployed DBs. SQLite has
  // no "ADD COLUMN IF NOT EXISTS", so we check the live column set first
  // and only ALTER when needed. Cheap and idempotent on every boot.
  const commentCols = new Set(
    (
      _db.pragma("table_info(comments)") as Array<{ name: string }>
    ).map((c) => c.name),
  );
  if (!commentCols.has("score")) {
    _db.exec(`ALTER TABLE comments ADD COLUMN score INTEGER`);
    log.info("migration: added comments.score");
  }
  if (!commentCols.has("parent_external_id")) {
    _db.exec(`ALTER TABLE comments ADD COLUMN parent_external_id TEXT`);
    log.info("migration: added comments.parent_external_id");
  }

  // posts.platform CHECK widening. SQLite has no ALTER CONSTRAINT, so when
  // the live table's CHECK is missing a newer platform (e.g. 'bluesky' was
  // added after the DB was created), we rebuild the table in place. Detected
  // by reading the CREATE TABLE SQL out of sqlite_master and substring-
  // matching the platform name. Idempotent: once 'bluesky' is in the CHECK,
  // we skip the rebuild on subsequent boots.
  const postsSqlRow = _db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'posts'`,
    )
    .get() as { sql: string } | undefined;
  if (postsSqlRow && !postsSqlRow.sql.includes("'bluesky'")) {
    log.info("migration: rebuilding posts to widen platform CHECK");
    _db.exec(`
      BEGIN;
      ALTER TABLE posts RENAME TO posts_old;
      CREATE TABLE posts (
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
      INSERT INTO posts
        (id, platform, external_id, permalink, title, body, author,
         posted_at, watch_enabled, source, created_at)
      SELECT id, platform, external_id, permalink, title, body, author,
             posted_at, watch_enabled, source, created_at
        FROM posts_old;
      DROP TABLE posts_old;
      COMMIT;
    `);
  }

  // project_context restructure: legacy schema had `summary` + `qa_json`
  // columns; new schema has `documentation_json`, `questions_json`, and
  // `answers_json`. Add the new columns idempotently; legacy columns
  // stay as orphans (SQLite can't easily drop columns) but unread.
  const projectCols = new Set(
    (
      _db.pragma("table_info(project_context)") as Array<{ name: string }>
    ).map((c) => c.name),
  );
  for (const col of [
    "documentation_json",
    "questions_json",
    "answers_json",
  ] as const) {
    if (!projectCols.has(col)) {
      _db.exec(`ALTER TABLE project_context ADD COLUMN ${col} TEXT`);
      log.info(`migration: added project_context.${col}`);
    }
  }

  return _db;
}

// Close the DB handle. Called from index.ts on SIGINT/SIGTERM so SQLite's
// WAL checkpoint runs before the process exits, otherwise the next boot
// has to replay the WAL log.
export function closeDb(): void {
  if (_db !== null) {
    log.info("closing sqlite database");
    _db.close();
    _db = null;
  }
}
