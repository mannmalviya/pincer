// GET /stats — counts for the dashboard's overview cards ("posts live",
// "pending replies", "comments tracked"). For this iteration we don't have
// classifications yet, so `pending_replies` is always 0 — we still return
// the field so the dashboard can render the existing card without an
// undefined.

import type { FastifyInstance } from "fastify";

import { getDb } from "../db.js";

export function registerStatsRoute(app: FastifyInstance): void {
  app.get("/stats", async () => {
    const db = getDb();

    // Three COUNT queries. Cheap on SQLite, no need for a single query
    // with subqueries.
    const postsTotal = (
      db.prepare(`SELECT COUNT(*) AS n FROM posts`).get() as { n: number }
    ).n;
    const postsWatching = (
      db
        .prepare(`SELECT COUNT(*) AS n FROM posts WHERE watch_enabled = 1`)
        .get() as { n: number }
    ).n;
    const commentsTracked = (
      db.prepare(`SELECT COUNT(*) AS n FROM comments`).get() as { n: number }
    ).n;

    return {
      posts_total: postsTotal,
      posts_watching: postsWatching,
      // Stays 0 until comment classification lands. Field exists so the
      // dashboard's "pending replies" card has something to bind to.
      pending_replies: 0,
      comments_tracked: commentsTracked,
    };
  });
}
