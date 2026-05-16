"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { FaBinoculars } from "react-icons/fa6";

import { registerPost } from "@/lib/agent";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import {
  loadSelectedPlatforms,
  PLATFORM_META,
  PLATFORM_ORDER,
  PUBLISHABLE_PLATFORMS,
  type Platform,
} from "@/lib/platforms";
import { PostEditor } from "../_components/post-editor";
import { SubredditCombobox } from "../_components/subreddit-combobox";
import { ToastStack, type ToastItem } from "../_components/toast";

// ---------------------------------------------------------------------------
// /dashboard/newpost — draft + publish a post.
//
// MVP shape (per latest scope conversation):
//   - Top row: platform pills for the platforms the user picked in
//     onboarding. The user toggles which of those to publish this draft to.
//   - Middle: a big body textarea (the "text box"), plus a title input
//     and a subreddit input that only appears when Reddit is selected.
//   - Bottom: Publish button. Calls the local browser-sidecar's /post
//     endpoint once per target platform and shows per-platform results.
//
// Chat / NIM-driven editing pane lives to the right in the next iteration.
// Starting with the bare publish path so the user can validate the
// sidecar wire end-to-end before layering in the assistant.
// ---------------------------------------------------------------------------

// Same sidecar base the onboarding wizard uses. Dev-only; will become an
// env var when we have a remote sidecar.
const SIDECAR_BASE = "http://localhost:9000";

// Per-platform result tracked after a publish run. Indexed by platform so
// re-publishing one platform updates only that row.
type PublishResult =
  | { state: "pending" }
  | { state: "ok"; url: string | null }
  | { state: "error"; message: string };

export default function NewPostPage() {
  // Platforms the user selected during onboarding. `null` means we
  // haven't read localStorage yet (initial server render). Empty array
  // means the user landed here without going through onboarding, in
  // which case we show a nudge back to /onboarding.
  const [onboarded, setOnboarded] = useState<Platform[] | null>(null);

  // Subset of `onboarded` the user wants to publish this particular draft
  // to. Defaults to every publishable onboarded platform on mount, since
  // "post everywhere I set up" is the common case.
  const [targets, setTargets] = useState<Set<Platform>>(new Set());

  // Draft fields. Title is required for both Reddit and HN. Subreddits
  // (plural) is required only when Reddit is a target — the user can
  // pick multiple subs to cross-post the same draft to, which we fan
  // out into one /post call per sub at publish time.
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [subreddits, setSubreddits] = useState<string[]>([]);

  // Publish-run state. Results are keyed by a per-target string:
  //   - "hn" for Hacker News
  //   - "reddit:<sub>" for each Reddit subreddit cross-post
  // The string-key flattens the platform x subreddit cartesian into a
  // single map that the results card can render row-by-row.
  const [publishing, setPublishing] = useState(false);
  const [results, setResults] = useState<Record<string, PublishResult>>({});

  // Two-phase Publish: phase 1 makes sure the Python sidecar is up
  // (auto-spawn if needed, same route the onboarding wizard uses);
  // phase 2 fires the actual /post calls. `bootingSidecar` is only
  // true during phase 1 so the button label can reflect the slower
  // cold-start state separately from "Publishing...".
  const [bootingSidecar, setBootingSidecar] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

  // Whether the published URL should be enrolled in the agent's 60s watch
  // loop. Defaults to on, since the usual reason to draft a post is to
  // see what comes back. Off still registers the post (so it shows up in
  // history and counts), but the agent skips it on subsequent ticks.
  const [trackPost, setTrackPost] = useState(true);

  // Toast queue. Each successful per-platform publish pushes one; the
  // Toast component auto-dismisses itself after ~3s and then calls back
  // here so the stack stays trimmed.
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  function pushToast(message: string) {
    // crypto.randomUUID is supported in all modern browsers and Node 18+.
    // The id only needs to be unique within the current toast stack.
    setToasts((cur) => [...cur, { id: crypto.randomUUID(), message }]);
  }

  function dismissToast(id: string) {
    setToasts((cur) => cur.filter((t) => t.id !== id));
  }

  // Read onboarding selection on mount. localStorage only exists in the
  // browser, so this has to live in an effect (the page is a client
  // component but its first render is server-side HTML).
  useEffect(() => {
    const stored = loadSelectedPlatforms();
    setOnboarded(stored);
    // Default-select every publishable platform the user onboarded with.
    // Non-publishable ones (discord/x/instagram/tiktok today) stay
    // unchecked since the sidecar would just reject them.
    setTargets(new Set(stored.filter((p) => PUBLISHABLE_PLATFORMS.has(p))));
  }, []);

  // Preserve onboarding order when rendering the pill row, regardless of
  // insertion order into the Set.
  const orderedOnboarded = useMemo(
    () => (onboarded ? PLATFORM_ORDER.filter((p) => onboarded.includes(p)) : []),
    [onboarded],
  );

  function toggleTarget(p: Platform) {
    setTargets((cur) => {
      const next = new Set(cur);
      if (next.has(p)) next.delete(p);
      else next.add(p);
      return next;
    });
  }

  // Mirrors what the sidecar's /post route demands, so we don't fire
  // requests that will obviously fail.
  const publishableTargets = useMemo(
    () => [...targets].filter((p) => PUBLISHABLE_PLATFORMS.has(p)),
    [targets],
  );
  const needsSubreddit = targets.has("reddit");
  const canPublish =
    !publishing &&
    !bootingSidecar &&
    publishableTargets.length > 0 &&
    title.trim().length > 0 &&
    body.trim().length > 0 &&
    (!needsSubreddit || subreddits.length > 0);

  // Flat list of every concrete "thing to post". One entry per HN
  // target, N entries per Reddit target (one per selected subreddit).
  // Used both for the seeded results map and the fan-out loop below.
  const publishJobs = useMemo<
    Array<{ key: string; platform: Platform; subreddit?: string }>
  >(() => {
    const jobs: Array<{ key: string; platform: Platform; subreddit?: string }> = [];
    for (const platform of publishableTargets) {
      if (platform === "reddit") {
        for (const sub of subreddits) {
          jobs.push({ key: `reddit:${sub}`, platform: "reddit", subreddit: sub });
        }
      } else {
        jobs.push({ key: platform, platform });
      }
    }
    return jobs;
  }, [publishableTargets, subreddits]);

  async function handlePublish() {
    setBootError(null);

    // Phase 1: ensure the Python sidecar is running. Same idempotent
    // /api/sidecar/start route the onboarding wizard uses. If the sidecar
    // is already up it returns immediately; otherwise it spawns uvicorn
    // and waits ~15s for /health. The persistent ./profile/ directory on
    // disk holds the user's login cookies and is untouched by start/stop,
    // so the user never has to re-authenticate just because the process
    // bounced between sessions.
    setBootingSidecar(true);
    try {
      const startRes = await fetch("/api/sidecar/start", { method: "POST" });
      const startData = (await startRes.json()) as {
        ok: boolean;
        error?: string;
      };
      if (!startData.ok) {
        setBootError(
          startData.error ?? "Could not start the browser sidecar.",
        );
        setBootingSidecar(false);
        return;
      }
    } catch {
      setBootError(
        "Could not reach the dashboard's sidecar control endpoint. " +
          "Make sure you're running this from `npm run dev` in the dashboard/ folder.",
      );
      setBootingSidecar(false);
      return;
    }
    setBootingSidecar(false);

    // Phase 2: the actual publish run.
    setPublishing(true);
    // Seed every job as pending so the user sees rows light up
    // immediately, then mutate each one as its request resolves.
    const seeded: Record<string, PublishResult> = {};
    for (const job of publishJobs) seeded[job.key] = { state: "pending" };
    setResults(seeded);

    // Fire requests in parallel. The sidecar's _post_lock serializes
    // them anyway (single Chromium profile), but starting them
    // concurrently lets the sidecar pick its own order and keeps the
    // client code simple. Multiple Reddit posts to different subs
    // queue up cleanly behind the lock.
    await Promise.all(
      publishJobs.map(async (job) => {
        try {
          const res = await fetch(`${SIDECAR_BASE}/post`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform: job.platform,
              title: title.trim(),
              body: body.trim(),
              // Subreddit only matters for Reddit; sidecar ignores it for HN.
              subreddit: job.subreddit,
            }),
          });
          const data = (await res.json()) as {
            ok: boolean;
            url?: string | null;
            error?: string;
          };
          setResults((cur) => ({
            ...cur,
            [job.key]: data.ok
              ? { state: "ok", url: data.url ?? null }
              : { state: "error", message: data.error ?? "Unknown error" },
          }));
          if (data.ok) {
            const label = job.subreddit
              ? `r/${job.subreddit}`
              : PLATFORM_META[job.platform].label;
            pushToast(`Posted successfully on ${label}`);
            // Fire-and-forget: tell the Brev agent to start watching this
            // post (records snapshots, fetches comments every 60s). Failures
            // get logged in the browser console but never block the UI.
            if (data.url) {
              void registerPost({
                url: data.url,
                source: "published",
                watch: trackPost,
              });
            }
          }
        } catch (err) {
          // Network-level failure (sidecar not running, CORS blocked,
          // etc). Surface the message verbatim so the user has something
          // actionable to copy into the sidecar terminal.
          setResults((cur) => ({
            ...cur,
            [job.key]: {
              state: "error",
              message:
                err instanceof Error
                  ? err.message
                  : "Could not reach the browser sidecar.",
            },
          }));
        }
      }),
    );
    setPublishing(false);
  }

  // Pre-onboarding fallback: nothing in localStorage. Render a small
  // explainer pointing back to /onboarding instead of an empty page.
  if (onboarded !== null && onboarded.length === 0) {
    return (
      <div className="flex flex-col gap-6 max-w-xl">
        <header>
          <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
            New Post
          </p>
          <h1 className="font-serif text-4xl tracking-tight mt-2">
            Connect a platform first.
          </h1>
        </header>
        <p className="text-foreground/70 leading-relaxed">
          Pincer doesn&apos;t know which platforms you want to publish to yet.
          Run the onboarding wizard to pick your platforms and sign in.
        </p>
        <Link
          href="/onboarding"
          className="rounded-full bg-foreground text-background px-6 h-11 flex items-center self-start font-medium hover:opacity-90"
        >
          Go to onboarding →
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      {/* Toast stack lives at the top center of the viewport via fixed
          positioning, so its parent layout doesn't matter. Mounted here
          (rather than in the dashboard layout) because today only this
          page emits toasts; promote it to the layout when other pages
          want them too. */}
      <ToastStack toasts={toasts} onDismiss={dismissToast} />

      <header>
        <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
          New Post
        </p>
        <h1 className="font-serif text-4xl tracking-tight mt-2">
          Draft and publish.
        </h1>
        <p className="text-foreground/70 mt-3 max-w-xl leading-relaxed">
          Pick which platforms to publish to, write your post, hit publish.
        </p>
      </header>

      {/* Platform pills. One per onboarded platform; click to toggle in/out
          of this draft's publish set. Non-publishable platforms are visible
          but disabled so the user can see what's coming. */}
      <section className="flex flex-col gap-2">
        <Label className="text-xs uppercase tracking-wider text-foreground/50">
          Publish to
        </Label>
        <div className="flex flex-wrap gap-2">
          {orderedOnboarded.map((p) => {
            const meta = PLATFORM_META[p];
            const Icon = meta.icon;
            const selected = targets.has(p);
            const publishable = PUBLISHABLE_PLATFORMS.has(p);
            return (
              <button
                key={p}
                type="button"
                disabled={!publishable}
                onClick={() => toggleTarget(p)}
                className={
                  "inline-flex items-center gap-2 rounded-full border px-3 h-9 text-sm transition-colors " +
                  (!publishable
                    ? "border-foreground/10 text-foreground/40 cursor-not-allowed"
                    : selected
                      ? "border-[color:var(--brand)] bg-[color:var(--brand)]/10 text-foreground"
                      : "border-foreground/15 text-foreground/70 hover:border-foreground/30 hover:bg-foreground/5")
                }
              >
                <Icon
                  className="text-base"
                  style={{ color: publishable ? meta.color : undefined }}
                  aria-hidden
                />
                <span>{meta.label}</span>
                {!publishable && (
                  <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/40">
                    soon
                  </span>
                )}
              </button>
            );
          })}
        </div>
      </section>

      {/* Compose fields. Subreddit only appears when Reddit is a target;
          title and body are now bundled inside the PostEditor card so
          the model can reason about (and rewrite) them as a single post. */}
      <section className="flex flex-col gap-4">
        {needsSubreddit && (
          <div className="flex flex-col gap-2">
            <Label htmlFor="post-subreddit">
              {subreddits.length > 1 ? "Subreddits" : "Subreddit"}
            </Label>
            <SubredditCombobox
              id="post-subreddit"
              value={subreddits}
              onChange={setSubreddits}
              placeholder="SideProject"
            />
            <p className="text-xs text-foreground/50">
              Posting to a sub you don&apos;t have karma in is the most
              common reason a Reddit post fails. Type a sub name and press
              Enter to add it — repeat for as many as you want.
            </p>
            {subreddits.length > 1 && (
              <div className="rounded-md border border-amber-500/40 bg-amber-500/10 text-xs text-amber-800 dark:text-amber-200 px-3 py-2 leading-relaxed">
                <strong className="font-semibold">Cross-posting warning:</strong>{" "}
                Reddit&apos;s anti-spam heuristics flag identical content
                posted to multiple subreddits in quick succession. Expect
                the second-and-later posts to land in modqueue, get
                shadow-removed, or trigger a rate-limit on your account.
                For real launches, space cross-posts out by an hour or
                more, or tailor the body per subreddit.
              </div>
            )}
          </div>
        )}

        {/* LLM-assisted post editor: title + body combined into one
            card on the left, chat panel on the right. The chat talks to
            /api/llm/edit (Nemotron Super via NIM); the model can
            propose changes to either the title or the body and they
            land as hunks in the diff view. */}
        <PostEditor
          title={title}
          onTitleChange={setTitle}
          body={body}
          onBodyChange={setBody}
          // Hint the model at tone: HN if HN-only or both, otherwise
          // Reddit. The system prompt in /api/llm/edit uses this to
          // bias word choice (no hype on HN, conversational on Reddit).
          platform={targets.has("hn") && !targets.has("reddit") ? "hn" : "reddit"}
        />
      </section>

      {/* Action bar. Publish on the right, per-platform results stack
          underneath so the user gets immediate feedback as each request
          resolves. */}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-end gap-3">
          {/* Track-this-post toggle. Binoculars = the agent's 60s watch
              loop. On = enroll the published URL; off = post and forget. */}
          <button
            type="button"
            onClick={() => setTrackPost((v) => !v)}
            aria-pressed={trackPost}
            title={
              trackPost
                ? "Pincer will watch this post for comments"
                : "Tracking off, Pincer will not watch this post"
            }
            className={
              "h-10 px-3 inline-flex items-center gap-2 rounded-full border text-sm transition-colors " +
              (trackPost
                ? "border-[color:var(--brand)] bg-[color:var(--brand)]/10 text-foreground"
                : "border-foreground/15 bg-transparent text-foreground/55 hover:text-foreground hover:border-foreground/30")
            }
          >
            <FaBinoculars className="text-base" aria-hidden />
            <span>{trackPost ? "Tracking on" : "Track this post"}</span>
          </button>
          <Button onClick={handlePublish} disabled={!canPublish}>
            {bootingSidecar
              ? "Starting sidecar..."
              : publishing
                ? "Publishing..."
                : "Publish"}
          </Button>
        </div>

        {bootError && (
          <p className="text-sm text-red-600 dark:text-red-400 text-right">
            {bootError}
          </p>
        )}

        {Object.keys(results).length > 0 && (
          <Card>
            <CardContent className="py-4 flex flex-col gap-2">
              {/* One result row per concrete publish job. For Reddit
                  with multiple subs, each sub gets its own row so the
                  user can see which cross-post succeeded vs failed. */}
              {publishJobs.map((job) => {
                const r = results[job.key];
                if (!r) return null;
                const meta = PLATFORM_META[job.platform];
                const Icon = meta.icon;
                return (
                  <div
                    key={job.key}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        className="text-base"
                        style={{ color: meta.color }}
                        aria-hidden
                      />
                      <span className="font-medium">
                        {meta.label}
                        {job.subreddit && (
                          <span className="ml-1.5 text-foreground/60 font-mono text-xs">
                            r/{job.subreddit}
                          </span>
                        )}
                      </span>
                    </span>
                    <ResultPill result={r} />
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}
      </section>
    </div>
  );
}

// Tiny status indicator: "Publishing..." while pending, link to the
// resulting post on success, red error message on failure.
function ResultPill({ result }: { result: PublishResult }) {
  if (result.state === "pending") {
    return <span className="text-foreground/60">Publishing...</span>;
  }
  if (result.state === "ok") {
    return result.url ? (
      <a
        href={result.url}
        target="_blank"
        rel="noreferrer"
        className="text-[color:var(--brand)] hover:underline"
      >
        View post →
      </a>
    ) : (
      <span className="text-foreground/70">Published</span>
    );
  }
  // Clamp the error to a few lines so a multi-kilobyte Playwright log
  // (we get those when Chromium dies mid-flow) can't blow up the row
  // height. Full text is available via the native tooltip on hover, and
  // selectable for copy-paste even when clamped.
  return (
    <span
      title={result.message}
      className={
        "text-red-600 dark:text-red-400 text-xs max-w-[60%] " +
        "line-clamp-3 break-words text-left"
      }
    >
      {result.message}
    </span>
  );
}
