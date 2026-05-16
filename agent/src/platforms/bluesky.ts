// Bluesky fetcher. Uses the public AppView at public.api.bsky.app/xrpc — no
// OAuth, no app password, no JWT. Bluesky's read endpoints are intentionally
// open to anonymous callers, which matches the Reddit/.json + HN/Firebase
// pattern we already use elsewhere.
//
// Cost shape: ONE round-trip per tick via app.bsky.feed.getPostThread, which
// returns the full reply tree inline (unlike HN, which needs a fetch per
// kid). For an active launch thread this is a single HTTP call per minute.
//
// `external_id` for a Bluesky post is the full AT URI:
//   at://did:plc:abc.../app.bsky.feed.post/<rkey>
// We pick the AT URI over the bare rkey because rkeys are only unique within
// a single repo (per-author), and we already need the URI to call any read
// endpoint. Storing it directly avoids an extra DID column on `posts`.

import { getJson } from "../lib/http.js";
import type { FetchedComment, FetchedPost } from "../types.js";

// Subset of the getPostThread response we care about. The full schema is
// generated from atproto lexicons; we only narrow to the fields we read.
type BskyAuthor = {
  did: string;
  handle?: string;
};

type BskyPostRecord = {
  // Record contents live under `record`. We only need text + createdAt.
  text?: string;
  createdAt?: string;  // ISO 8601 timestamp
};

type BskyPostView = {
  uri: string;          // AT URI of the post
  cid: string;
  author: BskyAuthor;
  record: BskyPostRecord;
  replyCount?: number;
  likeCount?: number;
  repostCount?: number;
  indexedAt?: string;
};

// A thread node is either a real post wrapped in `post`, OR a placeholder
// for content the AppView couldn't load (`#notFoundPost`, `#blockedPost`).
// We treat anything without a `.post` field as a skipped node.
type BskyThreadView = {
  $type?: string;
  post?: BskyPostView;
  parent?: BskyThreadView;
  replies?: BskyThreadView[];
};

type GetPostThreadResponse = {
  thread: BskyThreadView;
};

const BASE = "https://public.api.bsky.app/xrpc";

// Convert an ISO 8601 timestamp (what Bluesky returns) into the unix epoch
// seconds our DB stores. Returns null for missing or unparseable inputs so
// the column stays NULL rather than silently being 1970-01-01.
function isoToEpochSeconds(iso: string | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  return Math.floor(ms / 1000);
}

// Extract the rkey (the part after the final slash of an AT URI). Used to
// build the bsky.app permalink. AT URIs are guaranteed to end in /<rkey>.
function rkeyFromUri(uri: string): string {
  const idx = uri.lastIndexOf("/");
  return idx === -1 ? uri : uri.slice(idx + 1);
}

export async function fetchBlueskyPost(externalId: string): Promise<FetchedPost> {
  // depth=1000 grabs the whole reply tree in one shot. parentHeight=0
  // because we don't care about ancestors (a watched post is, by definition,
  // already the root the user cares about).
  const url =
    `${BASE}/app.bsky.feed.getPostThread` +
    `?uri=${encodeURIComponent(externalId)}` +
    `&depth=1000&parentHeight=0`;
  const data = await getJson<GetPostThreadResponse>(url);

  const root = data.thread.post;
  if (!root) {
    throw new Error(`Bluesky post ${externalId} is unavailable (blocked or not found)`);
  }

  const handle = root.author.handle ?? root.author.did;
  const rkey = rkeyFromUri(root.uri);

  // DFS the reply tree into a flat array, just like reddit.ts. parent_external_id
  // threads through so we can reconstruct nesting later without changing inserts.
  const comments: FetchedComment[] = [];
  function walk(nodes: BskyThreadView[] | undefined, parent: string | null) {
    if (!nodes) return;
    for (const node of nodes) {
      const p = node.post;
      // Skip #notFoundPost / #blockedPost placeholders — they have no `.post`.
      if (!p) continue;
      comments.push({
        external_id: p.uri,
        author: p.author.handle ?? p.author.did,
        body: p.record.text ?? null,
        posted_at:
          isoToEpochSeconds(p.record.createdAt) ??
          isoToEpochSeconds(p.indexedAt),
        score: p.likeCount ?? null,
        parent_external_id: parent,
      });
      walk(node.replies, p.uri);
    }
  }
  walk(data.thread.replies, null);

  return {
    external_id: root.uri,
    permalink: `https://bsky.app/profile/${handle}/post/${rkey}`,
    // Bluesky has no separate title field — the entire post is `record.text`.
    // Mirror HN's behavior of using title-only for link submissions: here we
    // leave title null and put the text in body, which is what the dashboard
    // already renders for bodyful posts.
    title: null,
    body: root.record.text ?? null,
    author: handle,
    posted_at:
      isoToEpochSeconds(root.record.createdAt) ??
      isoToEpochSeconds(root.indexedAt),
    // Map likeCount to score for parity with Reddit (upvotes). repostCount
    // would be a reasonable alternative; likeCount is the more common
    // engagement signal on Bluesky.
    score: root.likeCount ?? 0,
    comment_count: root.replyCount ?? 0,
    comments,
  };
}

// Resolve a Bluesky handle (e.g. "alice.bsky.social") to a stable DID
// (`did:plc:...`). Handles can be reassigned to different repos; DIDs cannot.
// Called from parse.ts when the user pastes a bsky.app/profile/<handle>/...
// URL so we store the canonical AT URI in `posts.external_id`.
export async function resolveHandleToDid(handle: string): Promise<string> {
  const url =
    `${BASE}/com.atproto.identity.resolveHandle` +
    `?handle=${encodeURIComponent(handle)}`;
  const data = await getJson<{ did: string }>(url);
  return data.did;
}
