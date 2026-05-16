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
