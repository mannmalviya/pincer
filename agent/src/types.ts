// Shared types across the agent. Mirrors the SQLite columns in schema.sql,
// but with TypeScript-native shapes (boolean for INTEGER 0/1, etc).

export type Platform = "reddit" | "hn";
export type PostSource = "published" | "backfill" | "manual";

// A row from the `posts` table, after coercing the SQLite INTEGER flag
// columns back into proper booleans. Anything that goes over HTTP to the
// dashboard takes this shape.
export type Post = {
  id: number;
  platform: Platform;
  external_id: string;
  permalink: string;
  title: string | null;
  body: string | null;
  author: string | null;
  posted_at: number | null;
  watch_enabled: boolean;
  source: PostSource;
  created_at: number;
};

// One snapshot row. Indexed by post; the time series for a single post is
// just all snapshots for that post ordered by fetched_at.
export type Snapshot = {
  id: number;
  post_id: number;
  fetched_at: number;
  score: number;
  comment_count: number;
};

// One comment row. We store every comment we've ever seen on a watched post
// so the dashboard can render a feed; the watch loop dedupes on
// (post_id, external_id) so we never insert the same comment twice.
export type Comment = {
  id: number;
  post_id: number;
  external_id: string;
  author: string | null;
  body: string | null;
  posted_at: number | null;
  fetched_at: number;
  // Reddit returns a per-comment score; HN does not. NULL = unknown.
  score: number | null;
  // Parent comment's external_id; NULL for top-level replies to the post.
  parent_external_id: string | null;
};

// The fetched-from-platform shape, before it lands in the DB. The watch
// loop converts each fetch into one snapshot insert and zero or more
// comment inserts.
export type FetchedPost = {
  external_id: string;
  permalink: string;
  title: string | null;
  body: string | null;
  author: string | null;
  posted_at: number | null;
  score: number;
  comment_count: number;
  comments: FetchedComment[];
};

export type FetchedComment = {
  external_id: string;
  author: string | null;
  body: string | null;
  posted_at: number | null;
  score: number | null;
  parent_external_id: string | null;
};
