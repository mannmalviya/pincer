// Type coercions between SQLite's wire format and the TypeScript-native
// shapes our HTTP layer + watch loop want. SQLite stores BOOLEAN as
// INTEGER (0 or 1), and better-sqlite3 returns the integer as-is; without
// these mappers we'd be checking `row.watch_enabled === 1` everywhere.
//
// All three mappers accept a `Record<string, unknown>` (which is what
// better-sqlite3's untyped `.all()` returns) and produce the appropriate
// type from types.ts. If the row shape ever drifts from the schema, these
// are the one place that breaks.

import type { Comment, Platform, Post, PostSource, Snapshot } from "../types.js";

export function rowToPost(row: Record<string, unknown>): Post {
  return {
    id: row.id as number,
    platform: row.platform as Platform,
    external_id: row.external_id as string,
    permalink: row.permalink as string,
    title: (row.title as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    author: (row.author as string | null) ?? null,
    posted_at: (row.posted_at as number | null) ?? null,
    watch_enabled: (row.watch_enabled as number) === 1,
    source: row.source as PostSource,
    created_at: row.created_at as number,
  };
}

export function rowToSnapshot(row: Record<string, unknown>): Snapshot {
  return {
    id: row.id as number,
    post_id: row.post_id as number,
    fetched_at: row.fetched_at as number,
    score: row.score as number,
    comment_count: row.comment_count as number,
  };
}

export function rowToComment(row: Record<string, unknown>): Comment {
  return {
    id: row.id as number,
    post_id: row.post_id as number,
    external_id: row.external_id as string,
    author: (row.author as string | null) ?? null,
    body: (row.body as string | null) ?? null,
    posted_at: (row.posted_at as number | null) ?? null,
    fetched_at: row.fetched_at as number,
    score: (row.score as number | null) ?? null,
    parent_external_id: (row.parent_external_id as string | null) ?? null,
  };
}
