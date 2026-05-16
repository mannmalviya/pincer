// URL parsing: given any Reddit or HN URL the user might paste (or that the
// browser-sidecar might return), extract (platform, external_id) so we can
// fetch metadata and watch the post.
//
// Forms we accept:
//
//   Reddit
//     https://www.reddit.com/r/<sub>/comments/<id>/<slug>/        ← full
//     https://www.reddit.com/r/<sub>/comments/<id>                ← no slug
//     https://www.reddit.com/comments/<id>                        ← what
//                                                                   the sidecar
//                                                                   returns
//     https://old.reddit.com/r/<sub>/comments/<id>/...            ← old UI
//     https://new.reddit.com/r/<sub>/comments/<id>/...            ← redirect target
//     https://redd.it/<id>                                        ← short link
//
//   Hacker News
//     https://news.ycombinator.com/item?id=<numeric>
//
// Anything that doesn't match returns null. The caller turns that into a 400.

import type { Platform } from "../types.js";

export type ParseResult = { platform: Platform; externalId: string };

export function parseUrl(input: string): ParseResult | null {
  // Trim anchor + trailing whitespace. Leave the query string intact — HN
  // needs `?id=N`. We'll strip it where it doesn't matter.
  const url = input.trim().replace(/#.*$/, "");

  // Reddit: /r/<sub>/comments/<id> (with optional slug) on www/old/new subdomains.
  const redditWithSub = url.match(
    /^https?:\/\/(?:www\.|old\.|new\.)?reddit\.com\/r\/[^/]+\/comments\/([a-z0-9]+)/i,
  );
  if (redditWithSub && redditWithSub[1]) {
    return { platform: "reddit", externalId: redditWithSub[1] };
  }

  // Reddit shortcut path (no /r/<sub>) — this is what browser-sidecar's
  // post_to_reddit() returns after a successful post.
  const redditNoSub = url.match(
    /^https?:\/\/(?:www\.|old\.)?reddit\.com\/comments\/([a-z0-9]+)/i,
  );
  if (redditNoSub && redditNoSub[1]) {
    return { platform: "reddit", externalId: redditNoSub[1] };
  }

  // Reddit shortlink (redd.it/<id>).
  const redditShort = url.match(/^https?:\/\/redd\.it\/([a-z0-9]+)/i);
  if (redditShort && redditShort[1]) {
    return { platform: "reddit", externalId: redditShort[1] };
  }

  // Hacker News item URL. Numeric ID only; HN never gives item IDs letters.
  const hn = url.match(
    /^https?:\/\/news\.ycombinator\.com\/item\?id=(\d+)/i,
  );
  if (hn && hn[1]) {
    return { platform: "hn", externalId: hn[1] };
  }

  return null;
}
