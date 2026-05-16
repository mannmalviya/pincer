// Reddit fetcher. Uses the unauthenticated public .json endpoint at
// reddit.com/comments/<id>.json — no OAuth, no credentials, no anti-bot
// nonsense as long as we send a non-generic User-Agent (set in config.ts
// + sent automatically by lib/http.ts).
//
// Response shape (heavily abbreviated):
//
//   [
//     { kind: "Listing", data: { children: [ { kind: "t3", data: {<post>} } ] } },
//     { kind: "Listing", data: { children: [ { kind: "t1", data: {<comment>} }, ... ] } }
//   ]
//
// The first listing is always exactly one post. The second is the comment
// tree, with nested replies under `data.replies`. We DFS-flatten the tree
// into a single comments array; the dashboard doesn't render threading yet.

import { getJson } from "../lib/http.js";
import type { FetchedPost, FetchedComment } from "../types.js";

// Reddit timestamps are unix epoch SECONDS (not ms). Pass through as-is —
// our DB schema also stores epoch seconds.
type RedditPostData = {
  id: string;
  title?: string;
  selftext?: string;
  author?: string;
  created_utc?: number;
  score?: number;
  num_comments?: number;
  permalink?: string;  // e.g. "/r/test/comments/abc/title/"
};

type RedditCommentData = {
  id: string;
  author?: string;
  body?: string;
  created_utc?: number;
  // `replies` is either an empty string "" when the comment has none, OR a
  // Listing object with its own children. Reddit's API is wonderfully
  // consistent like that.
  replies?: "" | { data: { children: Array<{ kind: string; data: RedditCommentData }> } };
};

type RedditListing<T> = {
  data: {
    children: Array<{ kind: string; data: T }>;
  };
};

export async function fetchRedditPost(externalId: string): Promise<FetchedPost> {
  // raw_json=1 disables Reddit's HTML-entity encoding in selftext/body
  // (otherwise "&amp;" instead of "&" etc). limit=500 grabs as many
  // comments as Reddit will return in one shot — past ~500 you'd need
  // the "morechildren" endpoint, out of scope here.
  const url = `https://www.reddit.com/comments/${externalId}.json?raw_json=1&limit=500`;

  const [postListing, commentsListing] = await getJson<
    [RedditListing<RedditPostData>, RedditListing<RedditCommentData>]
  >(url);

  // Defensive: a malformed listing (Reddit occasionally serves an error
  // page as JSON) gives an empty children array. Surface that as a clean
  // error rather than a cryptic "cannot read property of undefined".
  const postChild = postListing.data.children[0];
  if (!postChild || postChild.kind !== "t3") {
    throw new Error(`Reddit returned no post for id ${externalId}`);
  }
  const p = postChild.data;

  return {
    external_id: p.id,
    permalink: p.permalink
      ? `https://www.reddit.com${p.permalink}`
      : `https://www.reddit.com/comments/${p.id}`,
    title: p.title ?? null,
    body: p.selftext && p.selftext.length > 0 ? p.selftext : null,
    author: p.author ?? null,
    posted_at: p.created_utc ?? null,
    score: p.score ?? 0,
    comment_count: p.num_comments ?? 0,
    comments: flattenComments(commentsListing.data.children),
  };
}

// Walk the comment tree depth-first, returning every concrete t1 (comment)
// node we encounter. Skips `kind: "more"` nodes (placeholders for unloaded
// comment subtrees — fetching them requires a separate endpoint).
function flattenComments(
  children: Array<{ kind: string; data: RedditCommentData }>,
): FetchedComment[] {
  const out: FetchedComment[] = [];
  for (const child of children) {
    if (child.kind !== "t1") continue;
    const c = child.data;
    out.push({
      external_id: c.id,
      author: c.author ?? null,
      body: c.body ?? null,
      posted_at: c.created_utc ?? null,
    });
    // Recurse into replies if present. The "" form (no replies) short-
    // circuits the recursion.
    if (c.replies && typeof c.replies === "object") {
      out.push(...flattenComments(c.replies.data.children));
    }
  }
  return out;
}
