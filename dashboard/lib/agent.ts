// Thin client for the Pincer agent (Node backend on Brev).
//
// One module-level base URL, one helper per endpoint we actually call from
// the dashboard. Keeps the agent's HTTP shape in one place so adding a new
// route (e.g. POST /comments) is a one-line edit, and so we never sprinkle
// hardcoded "http://localhost:8000" through React components.
//
// AGENT_BASE resolution:
//   1. NEXT_PUBLIC_AGENT_URL from `.env.local` (set this to the Brev public
//      URL once you deploy: `https://port-8000-xxxxxx.brevlab.com`).
//   2. Falls back to `http://localhost:8000` for laptop dev when you're
//      running `npm run dev` in agent/ alongside the dashboard.
//
// All calls are fire-and-forget for now: failures get swallowed and logged
// to the browser console rather than thrown, because agent unavailability
// must NEVER block the UI's primary flow (publishing a post, etc).

export const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000";

// Register a freshly-published (or backfilled) post URL with the agent so
// it gets a snapshot row and shows up in the watch loop. Called after the
// sidecar returns a permalink from /post. Errors are swallowed: if the
// agent is offline, the post still went out, we just won't see analytics.
export async function registerPost(input: {
  url: string;
  source: "published" | "backfill";
  watch?: boolean;
}): Promise<void> {
  try {
    const res = await fetch(`${AGENT_BASE}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: input.url,
        source: input.source,
        watch: input.watch ?? true,
      }),
    });
    if (!res.ok) {
      // 4xx/5xx: log but don't throw. The UI shouldn't tell the user a
      // publish failed when the publish itself worked, just the side-channel
      // analytics registration didn't.
      const text = await res.text().catch(() => "");
      console.warn(
        `[agent] registerPost returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    // Network-level failure (agent down, DNS, CORS). Same swallow logic.
    console.warn(
      `[agent] registerPost network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Overview counts the dashboard renders in the top cards. Mirrors the
// shape returned by GET /stats on the agent.
export type AgentStats = {
  posts_total: number;
  posts_watching: number;
  pending_replies: number;
  comments_tracked: number;
};

// One row in the dashboard's flat comments feed. The agent inlines the
// originating post's platform + title + permalink so the UI doesn't need
// a follow-up lookup per comment.
export type AgentComment = {
  id: number;
  external_id: string;
  author: string | null;
  body: string | null;
  posted_at: number | null;
  fetched_at: number;
  // Reddit only — HN doesn't expose per-comment karma, so this is null
  // for every HN row.
  score: number | null;
  parent_external_id: string | null;
  post_id: number;
  platform: "reddit" | "hn";
  post_title: string | null;
  post_permalink: string;
};

// Returns null on failure (network error or 5xx) so the UI can render a
// dashed "agent offline" state instead of crashing.
export async function fetchComments(
  limit = 50,
): Promise<AgentComment[] | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/comments?limit=${limit}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { comments: AgentComment[] };
    return data.comments;
  } catch {
    return null;
  }
}

// Fetch the live counts. Returns null on failure so callers can render a
// graceful "agent offline" placeholder rather than crashing the page.
export async function fetchStats(): Promise<AgentStats | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/stats`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as AgentStats;
  } catch {
    return null;
  }
}
