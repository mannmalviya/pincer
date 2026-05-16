// One pass of "fetch this post and record what changed". Called by:
//   - The watch loop on each interval, for every post with watch_enabled=1.
//   - The /posts POST handler, immediately after inserting a new row, to
//     seed an initial snapshot and the current set of comments.
//
// Steps per tick:
//   1. Fetch the latest data from the platform (Reddit JSON / HN Firebase).
//   2. Insert one snapshot row capturing the current score + comment_count.
//   3. INSERT OR IGNORE each fetched comment — only the new ones land,
//      duplicates short-circuit on the (post_id, external_id) UNIQUE.
//
// Returns a small summary the HTTP handler can include in its response so
// the caller knows what just happened.

import { getDb } from "../db.js";
import { fetchFor } from "../platforms/index.js";
import type { Post } from "../types.js";

export type TickResult = {
  snapshot: { score: number; comment_count: number; fetched_at: number };
  commentsInserted: number;
};

export async function tick(post: Post): Promise<TickResult> {
  const db = getDb();
  const data = await fetchFor(post.platform, post.external_id);
  const now = Math.floor(Date.now() / 1000);

  // Insert the snapshot. Each tick produces exactly one new row, giving us
  // a clean time series. We explicitly pass `fetched_at` so the value is
  // identical to what we return in the response, instead of relying on
  // SQLite's `DEFAULT (unixepoch())` which would resolve a few microseconds
  // later.
  db.prepare(
    `INSERT INTO snapshots (post_id, fetched_at, score, comment_count)
     VALUES (?, ?, ?, ?)`,
  ).run(post.id, now, data.score, data.comment_count);

  // Bulk insert comments. INSERT OR IGNORE means duplicates (already-stored
  // comments) silently skip — only newly-seen comments increment changes.
  // We wrap the loop in a transaction so the round-trips collapse into one
  // commit; this matters when a post suddenly gets 30+ new replies.
  const insertComment = db.prepare(
    `INSERT OR IGNORE INTO comments
       (post_id, external_id, author, body, posted_at, fetched_at,
        score, parent_external_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMany = db.transaction((rows: typeof data.comments) => {
    let inserted = 0;
    for (const c of rows) {
      const res = insertComment.run(
        post.id,
        c.external_id,
        c.author,
        c.body,
        c.posted_at,
        now,
        c.score,
        c.parent_external_id,
      );
      // better-sqlite3's `changes` is 0 when INSERT OR IGNORE skipped the
      // row; 1 when it actually inserted. Summing gives us "new comments
      // this tick".
      if (res.changes > 0) inserted += 1;
    }
    return inserted;
  });

  const commentsInserted = insertMany(data.comments);

  return {
    snapshot: {
      score: data.score,
      comment_count: data.comment_count,
      fetched_at: now,
    },
    commentsInserted,
  };
}
