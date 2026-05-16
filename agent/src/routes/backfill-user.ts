// POST /backfill-user — enumerate every public post by a given username on
// Reddit, Hacker News, or Bluesky and register them as watched posts.
//
// Reddit:  GET reddit.com/user/{name}/submitted.json — public, no auth.
//          One page (limit=100) is plenty for indie hackers; if a user has
//          more, they can paginate manually via repeated paste.
// HN:      GET hn.algolia.com/api/v1/search_by_date?author={name}&tags=story
//          Algolia returns up to 1000 in a single page, sorted newest-first.
// Bluesky: GET public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed
//          ?actor={handle-or-did}&limit=100 — public AppView, no auth.
//          The endpoint mixes original posts with reposts and replies, so we
//          filter to top-level original posts before registering.
//
// We register each discovered URL via the shared registerByUrl helper, so
// the resulting rows are indistinguishable from individually-pasted URLs.

import type { FastifyInstance } from "fastify";

import { getJson } from "../lib/http.js";
import { log } from "../lib/log.js";
import { registerByUrl } from "../lib/register.js";

const BODY_SCHEMA = {
  type: "object",
  required: ["platform", "username"],
  properties: {
    platform: { type: "string", enum: ["reddit", "hn", "bluesky"] },
    // For Bluesky, `username` is either a handle (alice.bsky.social) or a
    // raw DID (did:plc:...). Handles can include dots, so we keep the
    // maxLength generous enough for full hostnames.
    username: { type: "string", minLength: 1, maxLength: 253 },
    // Whether to enroll the discovered posts in the watch loop. Defaults
    // to true; passing false records them as history without polling.
    watch: { type: "boolean" },
  },
  additionalProperties: false,
} as const;

// Reddit's /user/{name}/submitted.json shape, narrowed to fields we use.
type RedditSubmittedListing = {
  data: {
    children: Array<{
      kind: string;
      data: { id: string; permalink?: string };
    }>;
  };
};

// Algolia's HN search shape.
type AlgoliaHit = {
  objectID: string;
};
type AlgoliaResponse = {
  hits: AlgoliaHit[];
};

async function discoverRedditUrls(username: string): Promise<string[]> {
  // raw_json=1 keeps the response from HTML-entity-encoding fields.
  // sort=new orders newest-first so partial backfills cover the freshest.
  const url =
    `https://www.reddit.com/user/${encodeURIComponent(username)}/submitted.json` +
    `?limit=100&raw_json=1&sort=new`;
  const listing = await getJson<RedditSubmittedListing>(url);
  return listing.data.children
    .filter((c) => c.kind === "t3")
    .map((c) => `https://www.reddit.com/comments/${c.data.id}`);
}

async function discoverHnUrls(username: string): Promise<string[]> {
  const url =
    `https://hn.algolia.com/api/v1/search_by_date` +
    `?author=${encodeURIComponent(username)}&tags=story&hitsPerPage=1000`;
  const data = await getJson<AlgoliaResponse>(url);
  return data.hits.map(
    (h) => `https://news.ycombinator.com/item?id=${h.objectID}`,
  );
}

// One feed item from app.bsky.feed.getAuthorFeed. Narrowed to the fields we
// inspect: `reason` is present on reposts, `reply` on replies. Original
// top-level posts have neither.
type BskyFeedItem = {
  post: {
    uri: string;
    author: { did: string; handle?: string };
  };
  reason?: unknown;  // present on reposts (e.g. {$type: "...#reasonRepost"})
  reply?: unknown;   // present on replies (parent/root refs)
};

type BskyAuthorFeedResponse = {
  feed: BskyFeedItem[];
};

async function discoverBlueskyUrls(actor: string): Promise<string[]> {
  // limit=100 is the AppView's maximum per page. For a single-page backfill
  // of an indie hacker's launch posts this is plenty; deeper history would
  // need cursor-based pagination, deferred until someone asks.
  const url =
    `https://public.api.bsky.app/xrpc/app.bsky.feed.getAuthorFeed` +
    `?actor=${encodeURIComponent(actor)}&limit=100`;
  const data = await getJson<BskyAuthorFeedResponse>(url);

  // Filter out reposts (reason set) and replies (reply set). What's left
  // are the actor's own top-level posts, which is what "backfill my
  // launches" actually wants. We convert each AT URI into the canonical
  // bsky.app web URL; parseUrl re-resolves the handle on registration, so
  // we don't have to round-trip the DID here.
  return data.feed
    .filter((item) => item.reason === undefined && item.reply === undefined)
    .map((item) => {
      const handle = item.post.author.handle ?? item.post.author.did;
      const rkey = item.post.uri.slice(item.post.uri.lastIndexOf("/") + 1);
      return `https://bsky.app/profile/${handle}/post/${rkey}`;
    });
}

export function registerBackfillUserRoute(app: FastifyInstance): void {
  app.post<{
    Body: {
      platform: "reddit" | "hn" | "bluesky";
      username: string;
      watch?: boolean;
    };
  }>(
    "/backfill-user",
    { schema: { body: BODY_SCHEMA } },
    async (req, reply) => {
      const { platform, username, watch = true } = req.body;

      let urls: string[];
      try {
        switch (platform) {
          case "reddit":
            urls = await discoverRedditUrls(username);
            break;
          case "hn":
            urls = await discoverHnUrls(username);
            break;
          case "bluesky":
            urls = await discoverBlueskyUrls(username);
            break;
        }
      } catch (err) {
        return reply.code(502).send({
          error: {
            code: "discovery_failed",
            message: err instanceof Error ? err.message : String(err),
          },
        });
      }

      log.info("backfill-user discovered", {
        platform,
        username,
        found: urls.length,
      });

      // Register sequentially so we stay polite to Reddit / HN's public
      // endpoints (each register triggers an additional fetch via tick).
      let added = 0;
      let duplicates = 0;
      const errors: Array<{ url: string; message: string }> = [];
      for (const url of urls) {
        const r = await registerByUrl(url, "backfill", watch);
        if (!r.ok) {
          errors.push({ url, message: r.message });
        } else if (r.duplicate) {
          duplicates += 1;
        } else {
          added += 1;
        }
      }

      return {
        platform,
        username,
        found: urls.length,
        added,
        duplicates,
        errors,
      };
    },
  );
}
