"use client";

import { useEffect, useState } from "react";
import { FaHackerNews, FaRedditAlien } from "react-icons/fa6";

import { Card, CardContent } from "@/components/ui/card";
import { fetchComments, type AgentComment } from "@/lib/agent";

// CommentsFeed, the flat feed of every comment the agent has captured
// across every watched post. Polls /comments every 30s; before the first
// response renders nothing (we don't want to flash an empty state during
// the initial fetch).
//
// 30s matches OverviewStats so both refresh in lockstep. Comments are
// already deduped at the agent (UNIQUE post_id, external_id), so the
// dashboard just re-renders whatever the latest fetch returned.
const POLL_INTERVAL_MS = 30_000;
const FEED_LIMIT = 4;

export function CommentsFeed() {
  const [comments, setComments] = useState<AgentComment[] | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      const next = await fetchComments(FEED_LIMIT);
      if (cancelled) return;
      setComments(next);
      setLoaded(true);
    }

    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-baseline justify-between">
        <h2 className="text-sm uppercase tracking-wider text-foreground/50">
          Recent comments
        </h2>
        {loaded && comments !== null && (
          <span className="text-xs font-mono text-foreground/40">
            {comments.length} shown
          </span>
        )}
      </div>

      {!loaded && (
        <p className="text-sm text-foreground/45">Loading...</p>
      )}

      {loaded && comments === null && (
        <p className="text-sm text-foreground/45">
          Agent unreachable. Comments will populate once it&apos;s back.
        </p>
      )}

      {loaded && comments !== null && comments.length === 0 && (
        <p className="text-sm text-foreground/55 leading-relaxed">
          No comments yet. Once Pincer is watching a post with replies,
          they will appear here.
        </p>
      )}

      {loaded && comments !== null && comments.length > 0 && (
        <ul className="flex flex-col gap-3">
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentRow({ comment }: { comment: AgentComment }) {
  const isReddit = comment.platform === "reddit";
  // Reddit + HN both expose stable per-comment URLs:
  // Reddit:  {post_permalink}/comment/{external_id}
  // HN:      news.ycombinator.com/item?id={external_id}
  const commentUrl = isReddit
    ? `${comment.post_permalink.replace(/\/?$/, "")}/comment/${comment.external_id}`
    : `https://news.ycombinator.com/item?id=${comment.external_id}`;

  return (
    <li>
      <Card>
        <CardContent className="py-4 flex flex-col gap-2">
          {/* Header: platform glyph + author + post title (clickable). */}
          <div className="flex items-center gap-2 text-xs text-foreground/55">
            {isReddit ? (
              <FaRedditAlien
                className="shrink-0 text-base"
                style={{ color: "#FF4500" }}
                aria-hidden
              />
            ) : (
              <FaHackerNews
                className="shrink-0 text-base"
                style={{ color: "#FF6600" }}
                aria-hidden
              />
            )}
            <span className="font-mono">
              {comment.author ?? "anonymous"}
            </span>
            <span className="text-foreground/30">on</span>
            <a
              href={comment.post_permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="truncate hover:text-foreground transition-colors"
              title={comment.post_title ?? comment.post_permalink}
            >
              {comment.post_title ?? comment.post_permalink}
            </a>
            <span className="ml-auto shrink-0 font-mono text-foreground/40">
              {formatRelative(comment.posted_at ?? comment.fetched_at)}
            </span>
          </div>

          {/* Body. Clamp to 6 lines so a giant comment doesn't dominate
              the feed; the linked anchor jumps to the platform thread. */}
          <a
            href={commentUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm leading-relaxed text-foreground/85 hover:text-foreground line-clamp-6 whitespace-pre-wrap"
          >
            {comment.body?.trim() || "(empty)"}
          </a>
        </CardContent>
      </Card>
    </li>
  );
}

// Relative time formatter, "5m" / "3h" / "2d". Tiny and deterministic so
// no extra dep. Falls back to absolute date once the gap exceeds 30 days.
function formatRelative(unixSeconds: number): string {
  const now = Math.floor(Date.now() / 1000);
  const delta = Math.max(0, now - unixSeconds);
  if (delta < 60) return `${delta}s`;
  if (delta < 3600) return `${Math.floor(delta / 60)}m`;
  if (delta < 86_400) return `${Math.floor(delta / 3600)}h`;
  if (delta < 86_400 * 30) return `${Math.floor(delta / 86_400)}d`;
  return new Date(unixSeconds * 1000).toLocaleDateString();
}
