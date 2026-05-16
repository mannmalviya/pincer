// GET /comments — recent comments across every watched post, with the
// originating post's platform + title + permalink inlined so the dashboard
// can render a single flat feed without N+1 lookups.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db.js";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function registerCommentsRoute(app: FastifyInstance): void {
  app.get<{ Querystring: { limit?: string } }>(
    "/comments",
    async (req) => {
      // Clamp the limit so a runaway query can't dump the whole table.
      const requested = Number(req.query.limit ?? DEFAULT_LIMIT);
      const limit =
        Number.isFinite(requested) && requested > 0
          ? Math.min(Math.floor(requested), MAX_LIMIT)
          : DEFAULT_LIMIT;

      const db = getDb();
      // Order by posted_at when known, fall back to fetched_at for
      // comments where posted_at didn't make it into the row.
      const rows = db
        .prepare(
          `SELECT c.id                  AS id,
                  c.external_id         AS external_id,
                  c.author              AS author,
                  c.body                AS body,
                  c.posted_at           AS posted_at,
                  c.fetched_at          AS fetched_at,
                  c.score               AS score,
                  c.parent_external_id  AS parent_external_id,
                  p.id                  AS post_id,
                  p.platform            AS platform,
                  p.title               AS post_title,
                  p.permalink           AS post_permalink
             FROM comments c
             JOIN posts p ON p.id = c.post_id
            ORDER BY COALESCE(c.posted_at, c.fetched_at) DESC
            LIMIT ?`,
        )
        .all(limit) as Array<Record<string, unknown>>;

      const comments = rows.map((r) => ({
        id: r.id as number,
        external_id: r.external_id as string,
        author: (r.author as string | null) ?? null,
        body: (r.body as string | null) ?? null,
        posted_at: (r.posted_at as number | null) ?? null,
        fetched_at: r.fetched_at as number,
        score: (r.score as number | null) ?? null,
        parent_external_id: (r.parent_external_id as string | null) ?? null,
        post_id: r.post_id as number,
        platform: r.platform as "reddit" | "hn" | "bluesky",
        post_title: (r.post_title as string | null) ?? null,
        post_permalink: r.post_permalink as string,
      }));

      return { comments };
    },
  );
}
