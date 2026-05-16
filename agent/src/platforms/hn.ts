// Hacker News fetcher. Uses the official Firebase API at
// hacker-news.firebaseio.com/v0 — free, unauth, generous rate limits, and
// returns flat JSON for each item.
//
// Cost shape: one fetch for the story itself, then one fetch per top-level
// comment in `kids`. For a ~50-comment Show HN that's 51 round-trips per
// tick, which at 60s cadence stays well under HN's tolerance. If we ever
// drop the watch interval, switch to Algolia's
// https://hn.algolia.com/api/v1/search?tags=comment,story_<id>
// which returns the full descendant tree in a single response.

import { getJson } from "../lib/http.js";
import type { FetchedComment, FetchedPost } from "../types.js";

// Shape of one /v0/item/<id>.json response. HN reuses the same Item type
// for stories AND comments — `type` distinguishes them.
type HnItem = {
  id: number;
  type?: "story" | "comment" | "job" | "poll" | "pollopt";
  by?: string;                     // author username
  time?: number;                   // unix epoch seconds
  title?: string;                  // stories only
  text?: string;                   // self text (stories) or comment body
  url?: string;                    // link submissions only
  score?: number;                  // stories only; missing on aged items
  descendants?: number;            // total comment count (stories only)
  kids?: number[];                 // child item IDs
  dead?: boolean;
  deleted?: boolean;
};

const ITEM = (id: string | number) =>
  `https://hacker-news.firebaseio.com/v0/item/${id}.json`;

export async function fetchHnPost(externalId: string): Promise<FetchedPost> {
  const story = await getJson<HnItem | null>(ITEM(externalId));
  if (!story || story.deleted || story.dead) {
    throw new Error(`HN item ${externalId} is missing, deleted, or dead`);
  }

  // Fan out one fetch per top-level child. Promise.all → parallel; HN's
  // Firebase backend handles this fine. We skip recursing into reply
  // threads for now — top-level comments are the signal that matters for
  // a launch post's reception.
  const kidIds = story.kids ?? [];
  const kidPromises = kidIds.map((id) =>
    getJson<HnItem | null>(ITEM(id)).catch(() => null),
  );
  const kids = await Promise.all(kidPromises);

  const comments: FetchedComment[] = [];
  for (const k of kids) {
    if (!k || k.deleted || k.dead) continue;
    comments.push({
      external_id: String(k.id),
      author: k.by ?? null,
      body: k.text ?? null,
      posted_at: k.time ?? null,
      // HN's item endpoint doesn't return per-comment karma; stays null.
      score: null,
      // Top-level kids of the story have no parent comment.
      parent_external_id: null,
    });
  }

  return {
    external_id: String(story.id),
    permalink: `https://news.ycombinator.com/item?id=${story.id}`,
    title: story.title ?? null,
    body: story.text ?? null,
    author: story.by ?? null,
    posted_at: story.time ?? null,
    // HN drops `score` from /v0/item/<id> for stories that have aged out
    // of the active ranking. Fall back to 0 so we still record a snapshot
    // — the time-series is more useful than a gap.
    score: story.score ?? 0,
    // `descendants` is the total comment count (including nested replies).
    // We use it for the snapshot's comment_count even though we only store
    // top-level comment bodies — the count is still a useful signal.
    comment_count: story.descendants ?? 0,
    comments,
  };
}
