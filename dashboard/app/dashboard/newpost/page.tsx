"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";

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

  // Draft fields. Title is required for both Reddit and HN. Subreddit is
  // required only when reddit is a target.
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [subreddit, setSubreddit] = useState("");

  // Publish-run state. `results` is keyed by platform so we can show a
  // per-platform success/failure pill after the run finishes.
  const [publishing, setPublishing] = useState(false);
  const [results, setResults] = useState<Partial<Record<Platform, PublishResult>>>({});

  // Two-phase Publish: phase 1 makes sure the Python sidecar is up
  // (auto-spawn if needed, same route the onboarding wizard uses);
  // phase 2 fires the actual /post calls. `bootingSidecar` is only
  // true during phase 1 so the button label can reflect the slower
  // cold-start state separately from "Publishing...".
  const [bootingSidecar, setBootingSidecar] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);

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
    (!needsSubreddit || subreddit.trim().length > 0);

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
    // Seed every target as pending so the user sees rows light up
    // immediately, then mutate each one as its request resolves.
    const seeded: Partial<Record<Platform, PublishResult>> = {};
    for (const p of publishableTargets) seeded[p] = { state: "pending" };
    setResults(seeded);

    // Fire requests in parallel. The sidecar serializes them anyway
    // (single Chromium profile), but starting them concurrently lets the
    // sidecar pick its own order and keeps the client code simple.
    await Promise.all(
      publishableTargets.map(async (platform) => {
        try {
          const res = await fetch(`${SIDECAR_BASE}/post`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              platform,
              title: title.trim(),
              body: body.trim(),
              // Subreddit only matters for Reddit; sidecar ignores it
              // for HN. Trim + drop a leading r/ if the user typed it.
              subreddit:
                platform === "reddit"
                  ? subreddit.trim().replace(/^r\//i, "")
                  : undefined,
            }),
          });
          const data = (await res.json()) as {
            ok: boolean;
            url?: string | null;
            error?: string;
          };
          setResults((cur) => ({
            ...cur,
            [platform]: data.ok
              ? { state: "ok", url: data.url ?? null }
              : { state: "error", message: data.error ?? "Unknown error" },
          }));
          // Per-platform success toast at the top of the screen. Errors
          // already show inline in the results card, so we only celebrate
          // the wins here.
          if (data.ok) {
            pushToast(`Posted successfully on ${PLATFORM_META[platform].label}`);
          }
        } catch (err) {
          // Network-level failure (sidecar not running, CORS blocked,
          // etc). Surface the message verbatim so the user has something
          // actionable to copy into the sidecar terminal.
          setResults((cur) => ({
            ...cur,
            [platform]: {
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
            <Label htmlFor="post-subreddit">Subreddit</Label>
            <SubredditCombobox
              id="post-subreddit"
              value={subreddit}
              onChange={setSubreddit}
              placeholder="SideProject"
            />
            <p className="text-xs text-foreground/50">
              Posting to a sub you don&apos;t have karma in is the most
              common reason a Reddit post fails.
            </p>
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
        <div className="flex items-center justify-end">
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
              {publishableTargets.map((p) => {
                const r = results[p];
                if (!r) return null;
                const meta = PLATFORM_META[p];
                const Icon = meta.icon;
                return (
                  <div
                    key={p}
                    className="flex items-center justify-between gap-3 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <Icon
                        className="text-base"
                        style={{ color: meta.color }}
                        aria-hidden
                      />
                      <span className="font-medium">{meta.label}</span>
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
