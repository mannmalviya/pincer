// Dispatch: platform string → fetcher function. The watch loop and the
// /posts route both go through fetchFor() so they don't have to know which
// platform module to import.

import { fetchHnPost } from "./hn.js";
import { fetchRedditPost } from "./reddit.js";
import type { FetchedPost, Platform } from "../types.js";

export async function fetchFor(
  platform: Platform,
  externalId: string,
): Promise<FetchedPost> {
  switch (platform) {
    case "reddit":
      return fetchRedditPost(externalId);
    case "hn":
      return fetchHnPost(externalId);
  }
}

export { parseUrl } from "./parse.js";
