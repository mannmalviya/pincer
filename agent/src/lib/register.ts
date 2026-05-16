// registerByUrl, the shared "parse URL, INSERT, run one tick" path used by
// both POST /posts (single URL) and POST /backfill-user (bulk discovery).
// Extracted so both routes return the exact same envelope and stay in sync
// when the registration shape changes.

import { getDb } from "../db.js";
import { rowToPost } from "./row-mappers.js";
import { log } from "./log.js";
import { fetchFor } from "../platforms/index.js";
import { parseUrl } from "../platforms/parse.js";
import { tick } from "../watch/tick.js";
import type { Post, PostSource } from "../types.js";

export type RegisterResult =
  | {
      ok: true;
      post: Post;
      snapshot: { score: number; comment_count: number; fetched_at: number };
      commentsInserted: number;
      duplicate: boolean;
    }
  | { ok: false; code: "unparseable_url" | "fetch_failed"; message: string };

export async function registerByUrl(
  url: string,
  source: PostSource,
  watch: boolean,
): Promise<RegisterResult> {
  const parsed = await parseUrl(url);
  if (parsed === null) {
    return {
      ok: false,
      code: "unparseable_url",
      message: `Could not parse a Reddit, HN, or Bluesky URL from: ${url}`,
    };
  }

  const db = getDb();
  const existing = db
    .prepare(`SELECT * FROM posts WHERE platform = ? AND external_id = ?`)
    .get(parsed.platform, parsed.externalId) as
    | Record<string, unknown>
    | undefined;

  let post: Post;
  let duplicate = false;

  if (existing !== undefined) {
    post = rowToPost(existing);
    duplicate = true;
  } else {
    let data;
    try {
      data = await fetchFor(parsed.platform, parsed.externalId);
    } catch (err) {
      return {
        ok: false,
        code: "fetch_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }

    const result = db
      .prepare(
        `INSERT INTO posts
           (platform, external_id, permalink, title, body, author,
            posted_at, watch_enabled, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
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

  const tickResult = await tick(post);
  return {
    ok: true,
    post,
    snapshot: tickResult.snapshot,
    commentsInserted: tickResult.commentsInserted,
    duplicate,
  };
}
