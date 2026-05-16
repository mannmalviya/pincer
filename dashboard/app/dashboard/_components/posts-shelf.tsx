"use client";

// PostsShelf. Renders the agent's tracked posts as a recency-ordered
// shelf of cards. Each card is a link out to the original post's
// platform permalink.
//
// Ordering rationale: the agent already returns posts in `created_at DESC`
// (registration order with the agent). For most rows that matches the
// posting order, but for backfill rows it doesn't: a Reddit post from
// last month registered today would otherwise jump ahead of one
// published this morning. We re-sort by `posted_at` when it's present,
// falling back to `created_at`, so the user always sees "newest on the
// platform" at the top.
//
// Empty / error states stay quiet: a single short line each, no
// elaborate illustrations. The point of this page is "let me click
// through to a post I made", which is meaningless when there are no
// posts yet.

import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { fetchPosts, type AgentPost } from "@/lib/agent";
import { PLATFORM_META, type Platform } from "@/lib/platforms";

// Same tiny relative-time formatter the comments feed uses. Copied
// rather than shared to keep this component file standalone; if a third
// caller appears, promote it to lib/.
function formatRelative(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - unixSeconds);
  if (delta < 60) return `${delta}s ago`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h ago`;
  if (delta < 86_400 * 30) return `${Math.floor(delta / 86_400)}d ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}

// Pick the best timestamp to show + sort by. Prefer the platform's own
// posted-at (when the post actually went up) over the registration time.
function bestTimestamp(p: AgentPost): number {
  return p.posted_at && p.posted_at > 0 ? p.posted_at : p.created_at;
}

export function PostsShelf() {
  const [posts, setPosts] = useState<AgentPost[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const data = await fetchPosts();
      if (cancelled) return;
      setPosts(data);
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!loaded) {
    return <p className="text-sm text-foreground/55">Loading...</p>;
  }

  if (posts === null) {
    return (
      <p className="text-sm text-red-700 dark:text-red-400">
        Agent unreachable. Can&apos;t load your posts right now.
      </p>
    );
  }

  if (posts.length === 0) {
    return (
      <p className="text-sm text-foreground/55">
        Nothing tracked yet. Publish a post from New Post, or backfill
        an existing URL from Settings.
      </p>
    );
  }

  // Recency sort happens here, not on the agent, so a future change to
  // the agent's default order does not silently re-order this shelf.
  const sorted = [...posts].sort(
    (a, b) => bestTimestamp(b) - bestTimestamp(a),
  );

  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {sorted.map((post) => (
        <PostCard key={post.id} post={post} />
      ))}
    </ul>
  );
}

// One card on the shelf. Whole card is a single anchor so click target
// is generous and keyboard focus is one stop per post.
function PostCard({ post }: { post: AgentPost }) {
  // The agent's `platform` union ('reddit' | 'hn' | 'bluesky') is a strict
  // subset of the dashboard's Platform union, so the cast is safe. We
  // fall back to a neutral label/glyph if a future agent platform shows
  // up here before the dashboard's PLATFORM_META is updated.
  const meta = PLATFORM_META[post.platform as Platform];
  const Icon = meta?.icon;
  const platformColor = meta?.color ?? "var(--foreground)";
  const platformLabel = meta?.label ?? post.platform;

  const ts = bestTimestamp(post);
  const score = post.latest_snapshot?.score ?? null;
  const comments = post.latest_snapshot?.comment_count ?? null;

  return (
    <li>
      <a
        href={post.permalink}
        target="_blank"
        rel="noopener noreferrer"
        className="block group focus:outline-none"
      >
        <Card
          className="
            h-full transition-colors
            group-hover:border-foreground/30
            group-focus-visible:border-[color:var(--brand)]
          "
        >
          <CardContent className="flex flex-col gap-3 p-5">
            {/* Top row: platform glyph + label on the left, relative
                time on the right. Mirrors the comments-feed header. */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                {Icon ? (
                  <Icon
                    className="shrink-0 text-lg"
                    style={{ color: platformColor }}
                    aria-hidden
                  />
                ) : null}
                <span className="text-xs font-mono uppercase tracking-wider text-foreground/55">
                  {platformLabel}
                </span>
                {post.source !== "published" && (
                  <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/40 border border-foreground/10 rounded-full px-1.5 py-0.5">
                    {post.source}
                  </span>
                )}
              </div>
              <span
                className="text-xs text-foreground/55 shrink-0"
                title={new Date(ts * 1000).toLocaleString()}
              >
                {formatRelative(ts)}
              </span>
            </div>

            {/* Title. Clamped to two lines so cards stay the same height
                in the grid even when one title is much longer. */}
            <h3 className="font-serif text-lg tracking-tight leading-snug line-clamp-2 group-hover:underline">
              {post.title?.trim() || "(no title)"}
            </h3>

            {/* Bottom row: live counts when we have them, plus the
                author handle if the platform exposed one. */}
            <div className="flex items-center justify-between gap-3 text-xs text-foreground/55 mt-auto pt-1">
              <span className="truncate">
                {post.author ? `by ${post.author}` : ""}
              </span>
              {(score !== null || comments !== null) && (
                <span className="flex items-center gap-3 shrink-0 font-mono">
                  {score !== null && <span>{score} pts</span>}
                  {comments !== null && (
                    <span>
                      {comments} {comments === 1 ? "comment" : "comments"}
                    </span>
                  )}
                </span>
              )}
            </div>
          </CardContent>
        </Card>
      </a>
    </li>
  );
}
