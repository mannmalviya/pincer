// Admin / danger-zone endpoints. Right now this file holds one route:
//
//   POST /admin/reset-db
//     body: { confirm: "DELETE EVERYTHING" }
//
// Wipes every user-data table in the SQLite database while leaving the
// schema in place. Intended for hackathon-style iteration: between demos
// you usually want a clean slate (no stale posts, no half-answered
// onboarding, no leftover GitHub PAT) without having to ssh into Brev
// and `rm` the .sqlite file. The route is unauthenticated for the same
// reason the rest of the agent is (single-tenant demo, bind 127.0.0.1
// by default), but we still require a typed confirmation phrase in the
// body so a stray curl or replayed request can't trash state.
//
// Tables wiped (data only, schema stays):
//   - posts (CASCADEs to snapshots + comments)
//   - snapshots         (kept explicit in case CASCADE is ever turned off)
//   - comments
//   - project_context   (onboarding repo URL + Q/A)
//   - settings          (poll interval AND the stored GitHub PAT)
//
// We also reset the AUTOINCREMENT counters via sqlite_sequence so the
// next inserted post starts at id=1 again, which makes log lines and
// permalinks identical to a fresh install.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db.js";
import { log } from "../lib/log.js";
import { applyWatchSettings } from "../watch/loop.js";

// Server-side guard. The dashboard's UI asks the user to type this exact
// phrase; we re-check it here so a misconfigured client can't reset by
// accident. Keep it loud and unambiguous.
const CONFIRMATION_PHRASE = "DELETE EVERYTHING";

const RESET_BODY_SCHEMA = {
  type: "object",
  required: ["confirm"],
  properties: {
    confirm: { type: "string" },
  },
  additionalProperties: false,
} as const;

export function registerAdminRoutes(app: FastifyInstance): void {
  app.post<{ Body: { confirm: string } }>(
    "/admin/reset-db",
    { schema: { body: RESET_BODY_SCHEMA } },
    async (req, reply) => {
      // Re-validate the phrase even though the schema enforces the shape:
      // schema only checks the type, not the value.
      if (req.body.confirm !== CONFIRMATION_PHRASE) {
        return reply.code(400).send({
          error: {
            code: "bad_confirmation",
            message: `confirm must equal "${CONFIRMATION_PHRASE}"`,
          },
        });
      }

      const db = getDb();

      // Run the deletes in a single transaction so a mid-wipe crash can't
      // leave the DB half-empty (e.g. comments wiped but posts intact).
      // better-sqlite3's `transaction()` returns a function that re-throws
      // on error and rolls back automatically.
      const wipe = db.transaction(() => {
        // Order matters when foreign_keys = ON: children before parents.
        // CASCADE would cover this, but being explicit keeps the intent
        // obvious and survives someone toggling pragmas later.
        db.exec(`DELETE FROM comments`);
        db.exec(`DELETE FROM snapshots`);
        db.exec(`DELETE FROM posts`);
        db.exec(`DELETE FROM project_context`);
        db.exec(`DELETE FROM settings`);
        // Reset AUTOINCREMENT counters so the next inserted post is id=1.
        // sqlite_sequence only exists once at least one AUTOINCREMENT
        // table has been written to, so guard with IF EXISTS-equivalent
        // (SQLite has no IF EXISTS for DELETE, so we ignore the error
        // when the table is absent by querying sqlite_master first).
        const hasSequence = db
          .prepare(
            `SELECT 1 AS present FROM sqlite_master
              WHERE type = 'table' AND name = 'sqlite_sequence'`,
          )
          .get() as { present: number } | undefined;
        if (hasSequence) {
          db.exec(`DELETE FROM sqlite_sequence`);
        }
      });
      wipe();

      // After wiping settings, the watch loop's cached interval is stale
      // (the row it read from is gone). applyWatchSettings re-reads from
      // the DB; settings.ts re-creates the default rows on miss.
      applyWatchSettings();

      log.warn("admin: database wiped via /admin/reset-db");

      return { ok: true, wiped: true };
    },
  );
}
