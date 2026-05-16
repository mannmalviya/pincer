// The persistent watch loop. setInterval-driven, runs forever once started
// from index.ts. Each tick:
//
//   1. Reads every post with watch_enabled=1 from the DB.
//   2. Calls tick(post) for each one, sequentially. Per-post try/catch so
//      one platform's hiccup doesn't stall the others.
//   3. Logs a summary per post + a one-line summary for the whole tick.
//
// Reentry guard: if a tick takes longer than WATCH_INTERVAL_MS for any
// reason (slow Reddit response, lots of comments), the next interval fires
// while we're still running. We skip those — the next interval after we
// finish picks up cleanly. Without this guard, ticks would stack up and
// hammer Reddit's rate limit.

import { getDb } from "../db.js";
import { WATCH_INTERVAL_MS } from "../config.js";
import { log } from "../lib/log.js";
import type { Post } from "../types.js";
import { rowToPost } from "../lib/row-mappers.js";
import { tick } from "./tick.js";

let ticking = false;
let timer: NodeJS.Timeout | null = null;

export function startWatchLoop(): void {
  if (timer !== null) return; // idempotent — guarded against double-start
  log.info("watch loop starting", { intervalMs: WATCH_INTERVAL_MS });
  // Fire the first tick immediately on startup so the user doesn't have to
  // wait a full interval to see ANY data after boot. setInterval handles
  // every subsequent fire.
  void runOnce();
  timer = setInterval(() => void runOnce(), WATCH_INTERVAL_MS);
}

export function stopWatchLoop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

async function runOnce(): Promise<void> {
  if (ticking) {
    log.warn("watch tick skipped (previous tick still running)");
    return;
  }
  ticking = true;
  const startedAt = Date.now();

  try {
    const db = getDb();
    const rows = db
      .prepare("SELECT * FROM posts WHERE watch_enabled = 1")
      .all() as unknown[];
    const posts: Post[] = rows.map((r) => rowToPost(r as Record<string, unknown>));

    let successes = 0;
    let failures = 0;
    let totalCommentsInserted = 0;

    for (const post of posts) {
      try {
        const result = await tick(post);
        successes += 1;
        totalCommentsInserted += result.commentsInserted;
        log.info("tick ok", {
          postId: post.id,
          platform: post.platform,
          externalId: post.external_id,
          score: result.snapshot.score,
          comments: result.snapshot.comment_count,
          newComments: result.commentsInserted,
        });
      } catch (err) {
        failures += 1;
        log.error("tick failed", {
          postId: post.id,
          platform: post.platform,
          externalId: post.external_id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("watch tick complete", {
      watched: posts.length,
      successes,
      failures,
      newComments: totalCommentsInserted,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    ticking = false;
  }
}
