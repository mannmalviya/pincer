// The persistent watch loop. Driven by setInterval at the user-configured
// base period; on each scheduler tick we walk every watch_enabled post and
// only fetch the ones whose adaptive due-time has elapsed.
//
// Why adaptive: a Reddit post's score + comment velocity flattens within
// hours. Polling a 30-day-old launch post every 60s wastes Reddit quota
// without moving the snapshot graph. `adaptiveMultiplier(age)` returns
// the per-post stretch factor; the post is only ticked when
// `now - lastSnapshotFetchedAt >= baseInterval * multiplier`.
//
// The base interval doubles as the scheduler period. Two reasons:
//   1. There's no point checking due-times more often than the fastest
//      post would ever be polled.
//   2. The minimum multiplier is 1, so the scheduler period itself acts
//      as the floor on poll frequency.
//
// `applyWatchSettings()` is called by the PATCH /settings handler so a
// user-visible interval change takes effect without a process restart.

import { getDb } from "../db.js";
import { log } from "../lib/log.js";
import { adaptiveMultiplier, getSettings } from "../lib/settings.js";
import { rowToPost } from "../lib/row-mappers.js";
import type { Post } from "../types.js";
import { tick } from "./tick.js";

let ticking = false;
let timer: NodeJS.Timeout | null = null;
let currentBaseSeconds = 0;

export function startWatchLoop(): void {
  if (timer !== null) return;
  applyWatchSettings();
}

export function stopWatchLoop(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}

// Read the current base interval from settings and (re)schedule the timer
// to match. Idempotent: a no-op if the base hasn't changed since the last
// call. Safe to invoke from any code path that mutates settings.
export function applyWatchSettings(): void {
  const { basePollIntervalSeconds } = getSettings();
  if (timer !== null && basePollIntervalSeconds === currentBaseSeconds) {
    return;
  }
  if (timer !== null) clearInterval(timer);
  currentBaseSeconds = basePollIntervalSeconds;
  const intervalMs = currentBaseSeconds * 1000;
  log.info("watch loop (re)started", { baseSeconds: currentBaseSeconds });
  // First tick fires immediately so newly-registered posts don't have to
  // wait a full interval to record their initial snapshot via the loop
  // (the /posts handler already seeds one, this is for the next-time path).
  void runOnce();
  timer = setInterval(() => void runOnce(), intervalMs);
}

async function runOnce(): Promise<void> {
  if (ticking) {
    log.warn("watch tick skipped (previous tick still running)");
    return;
  }
  ticking = true;
  const startedAt = Date.now();
  const nowSeconds = Math.floor(startedAt / 1000);

  try {
    const { basePollIntervalSeconds, adaptivePollingEnabled } = getSettings();
    const db = getDb();

    // Join each post with the timestamp of its most recent snapshot so we
    // can decide "is this post due?" in one query. LEFT JOIN handles the
    // brand-new post case (no snapshots yet → always due).
    const rows = db
      .prepare(
        `SELECT p.*, (
            SELECT MAX(fetched_at) FROM snapshots WHERE post_id = p.id
          ) AS last_fetched_at
         FROM posts p
         WHERE p.watch_enabled = 1`,
      )
      .all() as Array<Record<string, unknown> & { last_fetched_at: number | null }>;

    let due = 0;
    let skippedNotDue = 0;
    let successes = 0;
    let failures = 0;
    let totalCommentsInserted = 0;

    for (const row of rows) {
      const post: Post = rowToPost(row);
      const lastFetched = row.last_fetched_at;

      // Adaptive due check. If adaptive is off, multiplier is always 1
      // (so every post polls at the base interval).
      const ageSeconds =
        post.posted_at !== null ? nowSeconds - post.posted_at : 0;
      const multiplier = adaptivePollingEnabled
        ? adaptiveMultiplier(ageSeconds)
        : 1;
      const dueAfter = basePollIntervalSeconds * multiplier;
      const elapsed =
        lastFetched === null ? Infinity : nowSeconds - lastFetched;

      if (elapsed < dueAfter) {
        skippedNotDue += 1;
        continue;
      }
      due += 1;

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
          multiplier,
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
      watched: rows.length,
      due,
      skippedNotDue,
      successes,
      failures,
      newComments: totalCommentsInserted,
      durationMs: Date.now() - startedAt,
    });
  } finally {
    ticking = false;
  }
}
