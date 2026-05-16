// POST /backfill-user — enumerate every public post by a given username on
// Reddit or Hacker News and register them as watched posts.
//
// Reddit: GET reddit.com/user/{name}/submitted.json — public, no auth.
//         One page (limit=100) is plenty for indie hackers; if a user has
//         more, they can paginate manually via repeated paste.
// HN:     GET hn.algolia.com/api/v1/search_by_date?author={name}&tags=story
//         Algolia returns up to 1000 in a single page, sorted newest-first.
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
    platform: { type: "string", enum: ["reddit", "hn"] },
    username: { type: "string", minLength: 1, maxLength: 64 },
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

export function registerBackfillUserRoute(app: FastifyInstance): void {
  app.post<{ Body: { platform: "reddit" | "hn"; username: string } }>(
    "/backfill-user",
    { schema: { body: BODY_SCHEMA } },
    async (req, reply) => {
      const { platform, username } = req.body;

      let urls: string[];
      try {
        urls =
          platform === "reddit"
            ? await discoverRedditUrls(username)
            : await discoverHnUrls(username);
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
        const r = await registerByUrl(url, "backfill", true);
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
