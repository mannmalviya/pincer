// /posts CRUD. Five endpoints:
//
//   POST   /posts        — register a Reddit/HN URL for watching
//   GET    /posts        — list everything we're tracking
//   GET    /posts/:id    — single post + full snapshot history + all comments
//   PATCH  /posts/:id    — toggle watch_enabled
//   DELETE /posts/:id    — unregister; FK cascades wipe snapshots + comments
//
// All responses are JSON. Errors are uniform `{ error: { code, message } }`
// shapes set by the central error handler in server.ts.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db.js";
import { rowToComment, rowToPost, rowToSnapshot } from "../lib/row-mappers.js";
import { log } from "../lib/log.js";
import { fetchFor } from "../platforms/index.js";
import { parseUrl } from "../platforms/parse.js";
import { tick } from "../watch/tick.js";
import type { Post, PostSource } from "../types.js";

// Request body schemas — Fastify uses these for runtime validation,
// rejecting bad shapes with a 400 before our handler runs.
const POST_BODY_SCHEMA = {
  type: "object",
  required: ["url"],
  properties: {
    url: { type: "string", minLength: 1 },
    watch: { type: "boolean" },
    source: { type: "string", enum: ["published", "backfill", "manual"] },
  },
  additionalProperties: false,
} as const;

const PATCH_BODY_SCHEMA = {
  type: "object",
  required: ["watch_enabled"],
  properties: {
    watch_enabled: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

export function registerPostsRoutes(app: FastifyInstance): void {
  // ---------------------------------------------------------------------
  // POST /posts — register a URL.
  //
  // Idempotent: if (platform, external_id) already exists, we return the
  // existing row with `duplicate: true` instead of 409. Two reasons:
  //   1. The dashboard's auto-register-on-publish flow can race a manual
  //      backfill paste of the same URL. 409 would force the dashboard to
  //      special-case "this isn't really an error".
  //   2. The user might re-paste a URL to refresh its data. Treat that as
  //      a no-op insert + a fresh tick.
  // ---------------------------------------------------------------------
  app.post<{
    Body: { url: string; watch?: boolean; source?: PostSource };
  }>(
    "/posts",
    { schema: { body: POST_BODY_SCHEMA } },
    async (req, reply) => {
      const { url, watch = true, source = "manual" } = req.body;

      const parsed = parseUrl(url);
      if (parsed === null) {
        return reply.code(400).send({
          error: {
            code: "unparseable_url",
            message: `Could not parse a Reddit or HN URL from: ${url}`,
          },
        });
      }

      const db = getDb();

      // Have we seen this post before?
      const existing = db
        .prepare(
          `SELECT * FROM posts WHERE platform = ? AND external_id = ?`,
        )
        .get(parsed.platform, parsed.externalId) as
        | Record<string, unknown>
        | undefined;

      let post: Post;
      let duplicate = false;

      if (existing !== undefined) {
        // Already-registered: leave the row alone (don't overwrite the
        // user's watch_enabled choice), just run a fresh tick to update
        // its snapshot history.
        post = rowToPost(existing);
        duplicate = true;
      } else {
        // Fresh URL. We need at minimum a permalink to insert the row,
        // and the platform fetcher returns the title/body/author/etc.
        // along with it. The same fetch's data is reused indirectly: the
        // tick we run after the INSERT calls fetchFor again, which is
        // mildly wasteful (one extra Reddit/HN request) but keeps the
        // tick path simple and lets the watch loop and the register
        // route share identical logic.
        const data = await fetchFor(parsed.platform, parsed.externalId);

        const insert = db.prepare(
          `INSERT INTO posts
             (platform, external_id, permalink, title, body, author,
              posted_at, watch_enabled, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        const result = insert.run(
          parsed.platform,
          data.external_id,
          data.permalink,
          data.title,
          data.body,
          data.author,
          data.posted_at,
          watch ? 1 : 0,
          source,
        );

        const inserted = db
          .prepare(`SELECT * FROM posts WHERE id = ?`)
          .get(result.lastInsertRowid) as Record<string, unknown>;
        post = rowToPost(inserted);
        log.info("post registered", {
          id: post.id,
          platform: post.platform,
          externalId: post.external_id,
          source,
        });
      }

      // Always run one tick on register — for new rows this seeds the
      // first snapshot + comments; for duplicates it refreshes the data
      // the user just pasted to confirm.
      const tickResult = await tick(post);

      return reply.send({
        post,
        snapshot: tickResult.snapshot,
        comments_inserted: tickResult.commentsInserted,
        duplicate,
      });
    },
  );

  // ---------------------------------------------------------------------
  // GET /posts — list everything we're tracking, each with the most
  // recent snapshot inlined (so the dashboard can render the list view
  // without making N+1 follow-up requests).
  // ---------------------------------------------------------------------
  app.get("/posts", async () => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT p.*,
                s.fetched_at    AS latest_fetched_at,
                s.score         AS latest_score,
                s.comment_count AS latest_comment_count
         FROM posts p
         LEFT JOIN snapshots s
           ON s.id = (
             SELECT id FROM snapshots
              WHERE post_id = p.id
              ORDER BY fetched_at DESC
              LIMIT 1
           )
         ORDER BY p.created_at DESC`,
      )
      .all() as Array<Record<string, unknown>>;

    const posts = rows.map((row) => {
      const post = rowToPost(row);
      const hasSnap = row.latest_fetched_at !== null;
      return {
        ...post,
        latest_snapshot: hasSnap
          ? {
              fetched_at: row.latest_fetched_at as number,
              score: row.latest_score as number,
              comment_count: row.latest_comment_count as number,
            }
          : null,
      };
    });

    return { posts };
  });

  // ---------------------------------------------------------------------
  // GET /posts/:id — single post + full snapshot history + every stored
  // comment. The dashboard renders the time-series chart from `snapshots`
  // and the comment feed from `comments`.
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/posts/:id",
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({
          error: { code: "bad_id", message: "post id must be a positive integer" },
        });
      }

      const db = getDb();
      const postRow = db
        .prepare(`SELECT * FROM posts WHERE id = ?`)
        .get(id) as Record<string, unknown> | undefined;
      if (postRow === undefined) {
        return reply.code(404).send({
          error: { code: "not_found", message: `no post with id ${id}` },
        });
      }

      const snapshots = (
        db
          .prepare(
            `SELECT * FROM snapshots WHERE post_id = ? ORDER BY fetched_at DESC`,
          )
          .all(id) as Array<Record<string, unknown>>
      ).map(rowToSnapshot);

      const comments = (
        db
          .prepare(
            `SELECT * FROM comments WHERE post_id = ? ORDER BY posted_at DESC`,
          )
          .all(id) as Array<Record<string, unknown>>
      ).map(rowToComment);

      return { post: rowToPost(postRow), snapshots, comments };
    },
  );

  // ---------------------------------------------------------------------
  // PATCH /posts/:id — toggle watch_enabled. Currently the only mutable
  // field — title/body etc. are immutable post-registration since they
  // mirror the source platform.
  // ---------------------------------------------------------------------
  app.patch<{
    Params: { id: string };
    Body: { watch_enabled: boolean };
  }>(
    "/posts/:id",
    { schema: { body: PATCH_BODY_SCHEMA } },
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({
          error: { code: "bad_id", message: "post id must be a positive integer" },
        });
      }

      const db = getDb();
      const result = db
        .prepare(`UPDATE posts SET watch_enabled = ? WHERE id = ?`)
        .run(req.body.watch_enabled ? 1 : 0, id);

      if (result.changes === 0) {
        return reply.code(404).send({
          error: { code: "not_found", message: `no post with id ${id}` },
        });
      }

      const updated = db
        .prepare(`SELECT * FROM posts WHERE id = ?`)
        .get(id) as Record<string, unknown>;
      log.info("watch toggled", {
        postId: id,
        watch_enabled: req.body.watch_enabled,
      });
      return { post: rowToPost(updated) };
    },
  );

  // ---------------------------------------------------------------------
  // DELETE /posts/:id — unregister. FK ON DELETE CASCADE wipes snapshots
  // + comments automatically (as long as PRAGMA foreign_keys=ON, which
  // db.ts sets at connection time).
  // ---------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/posts/:id",
    async (req, reply) => {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        return reply.code(400).send({
          error: { code: "bad_id", message: "post id must be a positive integer" },
        });
      }

      const db = getDb();
      const result = db.prepare(`DELETE FROM posts WHERE id = ?`).run(id);
      if (result.changes === 0) {
        return reply.code(404).send({
          error: { code: "not_found", message: `no post with id ${id}` },
        });
      }

      log.info("post deleted", { postId: id });
      return { deleted: true };
    },
  );
}
