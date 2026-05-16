// URL parsing: given any Reddit, HN, or Bluesky URL the user might paste (or
// that the browser-sidecar might return), extract (platform, external_id) so
// we can fetch metadata and watch the post.
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
//   Bluesky
//     https://bsky.app/profile/<handle>/post/<rkey>               ← web URL
//     https://bsky.app/profile/did:plc:.../post/<rkey>            ← DID form
//     at://did:plc:.../app.bsky.feed.post/<rkey>                  ← native AT URI
//
// The Bluesky forms with a `<handle>` require one extra HTTP call to resolve
// the handle into a DID, which is why this function is async. Reddit/HN
// branches return synchronously inside the same async function — the cost
// is one microtask, not a network round trip.
//
// Anything that doesn't match returns null. The caller turns that into a 400.

import { resolveHandleToDid } from "./bluesky.js";
import type { Platform } from "../types.js";

export type ParseResult = { platform: Platform; externalId: string };

export async function parseUrl(input: string): Promise<ParseResult | null> {
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

  // Bluesky native AT URI. Format: at://<did>/app.bsky.feed.post/<rkey>.
  // Already in canonical form, so no resolution needed — pass through
  // directly. We accept any AT URI shape under app.bsky.feed.post; other
  // collections (likes, follows, etc.) aren't posts we'd watch.
  const bskyAtUri = url.match(
    /^(at:\/\/did:[^/]+\/app\.bsky\.feed\.post\/[a-z0-9]+)$/i,
  );
  if (bskyAtUri && bskyAtUri[1]) {
    return { platform: "bluesky", externalId: bskyAtUri[1] };
  }

  // Bluesky web URL. The actor segment can be either a plain handle
  // (alice.bsky.social) or an inlined DID (did:plc:abc...). For the DID
  // form we can build the AT URI immediately. For the handle form we have
  // to resolve it to a DID — handles are mutable, DIDs are stable, and the
  // AppView API only accepts AT URIs.
  const bskyWeb = url.match(
    /^https?:\/\/bsky\.app\/profile\/([^/]+)\/post\/([a-z0-9]+)/i,
  );
  if (bskyWeb && bskyWeb[1] && bskyWeb[2]) {
    const actor = decodeURIComponent(bskyWeb[1]);
    const rkey = bskyWeb[2];
    let did: string;
    if (actor.startsWith("did:")) {
      did = actor;
    } else {
      try {
        did = await resolveHandleToDid(actor);
      } catch {
        // If the handle can't be resolved (typo, deactivated, network
        // hiccup) we treat the URL as unparseable, same as a bad Reddit
        // shortcode. The caller surfaces a 400 with the error message.
        return null;
      }
    }
    return {
      platform: "bluesky",
      externalId: `at://${did}/app.bsky.feed.post/${rkey}`,
    };
  }

  return null;
}
