"use client";

import { useEffect, useState } from "react";
import {
  FaCaretDown,
  FaCaretUp,
  FaHackerNews,
  FaRedditAlien,
  FaRegCopy,
  FaWandMagicSparkles,
} from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { draftReply, fetchComments, type AgentComment } from "@/lib/agent";

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
        <ul className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {comments.map((c) => (
            <CommentRow key={c.id} comment={c} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CommentRow({ comment }: { comment: AgentComment }) {
  // Reply-drafting state. The "Draft" button triggers a POST to the agent;
  // the response either lands in `draft` (success, with the text) or in
  // `error` (failure, with the agent's typed code/message).
  const [drafting, setDrafting] = useState(false);
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function handleDraft() {
    setDrafting(true);
    setError(null);
    setCopied(false);
    const res = await draftReply(comment.id);
    if (res.ok) {
      setDraft(res.draft);
    } else {
      setError(res.message);
    }
    setDrafting(false);
  }

  async function handleCopy() {
    if (!draft) return;
    try {
      await navigator.clipboard.writeText(draft);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard API can throw in non-secure-context iframes etc.
      // Swallow rather than red-flag a non-critical action.
    }
  }

  const isReddit = comment.platform === "reddit";
  // Per-comment URL. Reddit's canonical comment permalink appends the
  // comment id directly to the post permalink (no "/comment/" segment).
  // HN uses /item?id= for both stories and comments.
  const commentUrl = isReddit
    ? `${comment.post_permalink.replace(/\/?$/, "")}/${comment.external_id}`
    : `https://news.ycombinator.com/item?id=${comment.external_id}`;

  const platformLabel = isReddit ? "reddit.com" : "news.ycombinator.com";
  const author = comment.author ?? "anonymous";
  const platformColor = isReddit ? "#FF4500" : "#FF6600";
  const PlatformIcon = isReddit ? FaRedditAlien : FaHackerNews;

  return (
    <li>
      <div className="rounded-2xl bg-foreground/[0.06] border border-foreground/10 shadow-sm p-5 flex flex-col gap-4">
        {/* Header row: platform-logo avatar + author / post title. */}
        <div className="flex items-start gap-3">
          <div
            className="shrink-0 w-10 h-10 rounded-full flex items-center justify-center"
            style={{ backgroundColor: platformColor }}
            aria-hidden
          >
            <PlatformIcon className="text-white text-lg" aria-hidden />
          </div>

          <div className="flex flex-col min-w-0 flex-1">
            <a
              href={commentUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold tracking-tight text-foreground truncate hover:underline"
              title={author}
            >
              {author}
            </a>
            <a
              href={comment.post_permalink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-foreground/55 truncate hover:text-foreground transition-colors"
              title={comment.post_title ?? comment.post_permalink}
            >
              {platformLabel}
              {comment.post_title ? ` · ${comment.post_title}` : ""}
            </a>
          </div>
        </div>

        {/* Body. Larger leading + foreground/70 to match the mockup's
            quiet, readable body block. Clamp to 6 lines so a wall of
            text doesn't dominate the feed. */}
        <a
          href={commentUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="text-base leading-relaxed text-foreground/70 hover:text-foreground line-clamp-6 whitespace-pre-wrap"
        >
          {comment.body?.trim() || "(empty)"}
        </a>

        {/* Footer: score pill (Reddit only) + relative timestamp +
            draft-reply action. The button kicks off a NIM call to draft
            a reply grounded in the launch post; the result lands in
            `draft` and renders below. */}
        <div className="flex items-center gap-3 text-xs text-foreground/40 font-mono">
          {comment.score !== null && <RedditScore score={comment.score} />}
          <button
            type="button"
            onClick={handleDraft}
            disabled={drafting}
            className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-foreground/15 hover:border-foreground/30 hover:text-foreground transition-colors disabled:opacity-60"
          >
            <FaWandMagicSparkles aria-hidden />
            <span>{drafting ? "Drafting..." : "Draft reply"}</span>
          </button>
          <span className="ml-auto">
            {formatRelative(comment.posted_at ?? comment.fetched_at)}
          </span>
        </div>

        {/* Drafted-reply panel. Renders only after the first draft call. */}
        {(draft !== null || error !== null) && (
          <div className="rounded-xl border border-foreground/10 bg-background/60 p-3 flex flex-col gap-2">
            {error && (
              <p className="text-xs text-red-700 dark:text-red-400 font-mono">
                {error}
              </p>
            )}
            {draft && (
              <>
                <p className="text-sm leading-relaxed text-foreground/85 whitespace-pre-wrap">
                  {draft}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleCopy}
                    variant="ghost"
                    className="h-8 px-2 text-xs"
                  >
                    <FaRegCopy className="mr-1" aria-hidden />
                    {copied ? "Copied" : "Copy"}
                  </Button>
                  <Button
                    onClick={handleDraft}
                    variant="ghost"
                    className="h-8 px-2 text-xs"
                  >
                    Regenerate
                  </Button>
                </div>
              </>
            )}
          </div>
        )}
      </div>
    </li>
  );
}

// Reddit-style net-score widget: ▲ N ▼ in brand orange, no fill behind it.
// Direction comes from the sign — active arrow is fully colored, the
// inactive arrow fades back. The number stays orange so the widget reads
// as one unit even at small sizes.
function RedditScore({ score }: { score: number }) {
  const upActive = score >= 0;

  return (
    <span
      className="shrink-0 inline-flex items-center gap-1 font-mono text-xs text-[color:var(--brand)]"
      title={`Score ${score}`}
    >
      <FaCaretUp
        className={"text-base " + (upActive ? "opacity-100" : "opacity-40")}
        aria-hidden
      />
      <span>{Math.abs(score)}</span>
      <FaCaretDown
        className={"text-base " + (!upActive ? "opacity-100" : "opacity-40")}
        aria-hidden
      />
    </span>
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
