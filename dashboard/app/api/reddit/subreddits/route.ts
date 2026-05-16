/**
 * GET /api/reddit/subreddits?q=foo
 *
 * Proxies Reddit's subreddit autocomplete endpoint so the New Post page's
 * subreddit combobox can suggest matches as the user types. Has to be a
 * server-side proxy because Reddit doesn't return CORS headers for direct
 * browser calls, and the dashboard runs on a different origin than reddit.com.
 *
 * Returns a minimal shape, [{name, subscribers}, ...]. We don't surface
 * Reddit's full payload because (a) the combobox doesn't need it and (b)
 * leaking the entire response shape couples the UI to Reddit's API drift.
 *
 * Anonymous usage. Personalized ranking (the user's own subs first) would
 * require forwarding the Reddit session cookies the sidecar persists, which
 * isn't worth wiring up just for autocomplete order.
 */

import { NextResponse } from "next/server";

// Reddit blocks/rate-limits requests without a distinctive User-Agent very
// aggressively (it's their #1 abuse signal). Per their public guidance,
// include a contact handle when the app has one; for a local-only dev tool
// "anonymous" is acceptable and won't get throttled in practice.
const REDDIT_UA = "pincer-dashboard/0.1 (local dev, by /u/anonymous)";

// Cap so a single keystroke can't pull a 100-item payload. Reddit's
// autocomplete tops out around 10 anyway.
const RESULT_LIMIT = 10;

type SuggestItem = { name: string; subscribers: number };

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  // Strip a leading r/ so users who paste "r/SideProject" get the same
  // results as "SideProject". Reddit's endpoint expects the bare name.
  const raw = (searchParams.get("q") ?? "").trim().replace(/^r\//i, "");

  // Empty / single-char queries return useless noise; cheaper to just
  // 200-with-empty than round-trip to Reddit.
  if (raw.length < 2) {
    return NextResponse.json<{ items: SuggestItem[] }>({ items: [] });
  }

  const upstream = new URL(
    "https://www.reddit.com/api/subreddit_autocomplete_v2.json",
  );
  upstream.searchParams.set("query", raw);
  upstream.searchParams.set("include_over_18", "true");
  upstream.searchParams.set("include_profiles", "false");
  upstream.searchParams.set("limit", String(RESULT_LIMIT));

  try {
    const res = await fetch(upstream, {
      headers: { "User-Agent": REDDIT_UA },
      // Combobox typing fires frequently, so cache per-query at the Next
      // edge for a few seconds. The same query within the debounce window
      // shouldn't hit Reddit twice.
      next: { revalidate: 30 },
    });

    if (!res.ok) {
      // 429 / 503 from Reddit happens occasionally. Return empty rather
      // than propagating the error code; the UI will just show "no
      // suggestions" which is the right UX for a transient hiccup.
      return NextResponse.json<{ items: SuggestItem[] }>({ items: [] });
    }

    const data = (await res.json()) as {
      data?: {
        children?: Array<{
          kind?: string;
          data?: {
            display_name?: string;
            subscribers?: number;
          };
        }>;
      };
    };

    const items: SuggestItem[] = (data.data?.children ?? [])
      // Reddit's listing can include users (kind: "t2") if you forget
      // include_profiles=false; defensively filter to subreddits only.
      .filter((c) => c.kind === "t5" && c.data?.display_name)
      .slice(0, RESULT_LIMIT)
      .map((c) => ({
        name: c.data!.display_name!,
        subscribers: c.data!.subscribers ?? 0,
      }));

    return NextResponse.json<{ items: SuggestItem[] }>({ items });
  } catch {
    // Network error / Reddit unreachable. Empty list is the safest UX.
    return NextResponse.json<{ items: SuggestItem[] }>({ items: [] });
  }
}
