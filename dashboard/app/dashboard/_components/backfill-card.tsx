"use client";

import { useState } from "react";
import { FaBinoculars } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AGENT_BASE } from "@/lib/agent";

// BackfillCard, an always-available form to register existing Reddit / HN
// posts with the agent's watch loop. Two modes:
//
//   - URL mode: paste specific links, one per line.
//   - User mode: type a Reddit or HN username; the agent enumerates every
//     public submission and registers them all in one shot.
//
// Per-URL result rows show what happened (added vs. duplicate vs. error)
// so the user can see exactly which links the agent accepted.
type Result = {
  url: string;
  state: "added" | "duplicate" | "error";
  detail?: string;
};

type UserSummary = {
  platform: "reddit" | "hn";
  username: string;
  found: number;
  added: number;
  duplicates: number;
  errors: Array<{ url: string; message: string }>;
};

export function BackfillCard() {
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [results, setResults] = useState<Result[]>([]);

  // User-mode state. Two separate username fields because Reddit and HN
  // usernames have no overlap and most users have distinct handles.
  const [redditUser, setRedditUser] = useState("");
  const [hnUser, setHnUser] = useState("");
  const [userSubmitting, setUserSubmitting] = useState(false);
  const [userSummaries, setUserSummaries] = useState<UserSummary[]>([]);
  const [userError, setUserError] = useState<string | null>(null);

  // Whether discovered/pasted posts get enrolled in the agent's 60s watch
  // loop. On = comments + score snapshots accrue over time. Off = the
  // posts are registered as history without polling them again. Default
  // on because that's the whole point of backfilling.
  const [watchAll, setWatchAll] = useState(true);

  async function handleUserSubmit() {
    setUserSubmitting(true);
    setUserError(null);
    setUserSummaries([]);
    const targets: Array<{ platform: "reddit" | "hn"; username: string }> = [];
    if (redditUser.trim().length > 0)
      targets.push({ platform: "reddit", username: redditUser.trim() });
    if (hnUser.trim().length > 0)
      targets.push({ platform: "hn", username: hnUser.trim() });

    const summaries: UserSummary[] = [];
    for (const t of targets) {
      try {
        const res = await fetch(`${AGENT_BASE}/backfill-user`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...t, watch: watchAll }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          setUserError(
            `${t.platform}/${t.username}: ${body.error?.message ?? `HTTP ${res.status}`}`,
          );
          continue;
        }
        const summary = (await res.json()) as UserSummary;
        summaries.push(summary);
        setUserSummaries([...summaries]);
      } catch (err) {
        setUserError(err instanceof Error ? err.message : String(err));
      }
    }
    setUserSubmitting(false);
  }

  const urls = value
    .split(/\s+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0);

  async function handleSubmit() {
    setSubmitting(true);
    setResults([]);
    // Sequential rather than Promise.all so the agent's outbound fetches
    // to Reddit / HN aren't all racing at once. Backfill is rare and the
    // user is watching, latency is fine.
    const next: Result[] = [];
    for (const url of urls) {
      try {
        const res = await fetch(`${AGENT_BASE}/posts`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url, source: "backfill", watch: watchAll }),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as {
            error?: { message?: string };
          };
          next.push({
            url,
            state: "error",
            detail: body.error?.message ?? `HTTP ${res.status}`,
          });
        } else {
          const body = (await res.json()) as { duplicate?: boolean };
          next.push({
            url,
            state: body.duplicate ? "duplicate" : "added",
          });
        }
      } catch (err) {
        next.push({
          url,
          state: "error",
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      setResults([...next]);
    }
    setSubmitting(false);
    // Clear the textarea on a fully successful run so the user can paste
    // another batch without manually clearing. Leave it intact if there
    // were errors so they can edit and retry.
    if (next.every((r) => r.state !== "error")) setValue("");
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-xl tracking-tight">
          Backfill existing posts
        </CardTitle>
        <CardDescription>
          Add existing Reddit or Hacker News posts to the watch list. Use
          your username to pull every post at once, or paste specific URLs.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Shared watch toggle. Applies to every URL the user submits from
            this card, whether by username or by URL. Default on because
            backfilling without watching just records dead history. */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-foreground/10 bg-foreground/[0.02] px-3 py-2">
          <div className="flex items-center gap-2">
            <FaBinoculars
              className={
                "text-base " +
                (watchAll ? "text-[color:var(--brand)]" : "text-foreground/40")
              }
              aria-hidden
            />
            <div className="flex flex-col">
              <span className="text-sm font-medium">
                Watch all backfilled posts
              </span>
              <span className="text-xs text-foreground/55">
                {watchAll
                  ? "Pincer will poll each post every 60s for new comments."
                  : "Posts are recorded but not polled. You can toggle individually later."}
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setWatchAll((v) => !v)}
            role="switch"
            aria-checked={watchAll}
            className={
              "shrink-0 w-11 h-6 rounded-full border transition-colors relative " +
              (watchAll
                ? "bg-[color:var(--brand)] border-[color:var(--brand)]"
                : "bg-foreground/10 border-foreground/15")
            }
          >
            <span
              className={
                "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform " +
                (watchAll ? "translate-x-5" : "translate-x-0.5")
              }
            />
          </button>
        </div>

        {/* User mode: agent enumerates every public submission for the
            given username on each platform and registers them in bulk. */}
        <div className="flex flex-col gap-3">
          <p className="text-xs uppercase tracking-wider text-foreground/55 font-mono">
            By username
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-foreground/65">Reddit username</span>
              <input
                type="text"
                value={redditUser}
                onChange={(e) => setRedditUser(e.target.value)}
                spellCheck={false}
                placeholder="spez"
                disabled={userSubmitting}
                className="rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:border-foreground/40 disabled:opacity-60"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-foreground/65">Hacker News username</span>
              <input
                type="text"
                value={hnUser}
                onChange={(e) => setHnUser(e.target.value)}
                spellCheck={false}
                placeholder="pg"
                disabled={userSubmitting}
                className="rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:border-foreground/40 disabled:opacity-60"
              />
            </label>
          </div>
          <div className="flex items-center justify-end">
            <Button
              onClick={handleUserSubmit}
              disabled={
                userSubmitting ||
                (redditUser.trim().length === 0 && hnUser.trim().length === 0)
              }
            >
              {userSubmitting ? "Pulling posts..." : "Pull all my posts"}
            </Button>
          </div>

          {userSummaries.length > 0 && (
            <ul className="flex flex-col gap-1 text-xs font-mono">
              {userSummaries.map((s) => (
                <li
                  key={`${s.platform}-${s.username}`}
                  className="p-2 rounded border border-green-500/30 bg-green-500/5"
                >
                  <span className="uppercase tracking-wider text-[10px]">
                    {s.platform}
                  </span>{" "}
                  <span className="text-foreground/70">{s.username}:</span>{" "}
                  <span>
                    {s.added} added, {s.duplicates} already tracked
                    {s.errors.length > 0 ? `, ${s.errors.length} errors` : ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {userError && (
            <p className="text-xs text-red-700 dark:text-red-400 font-mono">
              {userError}
            </p>
          )}
        </div>

        <div className="h-px bg-foreground/10" aria-hidden />

        <div className="flex flex-col gap-3">
          <p className="text-xs uppercase tracking-wider text-foreground/55 font-mono">
            By URL
          </p>
        <textarea
          value={value}
          onChange={(e) => setValue(e.target.value)}
          rows={5}
          spellCheck={false}
          placeholder={
            "https://www.reddit.com/r/SideProject/comments/abc123/...\n" +
            "https://news.ycombinator.com/item?id=12345678"
          }
          disabled={submitting}
          className="w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm leading-relaxed resize-y focus:outline-none focus:border-foreground/40 disabled:opacity-60"
        />
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-foreground/55 font-mono">
            {urls.length === 0
              ? "No URLs yet."
              : `${urls.length} URL${urls.length === 1 ? "" : "s"} ready.`}
          </p>
          <Button
            onClick={handleSubmit}
            disabled={submitting || urls.length === 0}
          >
            {submitting ? "Adding..." : "Add to watch list"}
          </Button>
        </div>

        {results.length > 0 && (
          <ul className="flex flex-col gap-1 mt-2 text-xs font-mono">
            {results.map((r, i) => (
              <li
                key={`${r.url}-${i}`}
                className={
                  "flex items-start gap-2 p-2 rounded border " +
                  (r.state === "added"
                    ? "border-green-500/30 bg-green-500/5"
                    : r.state === "duplicate"
                      ? "border-foreground/15 bg-foreground/[0.02]"
                      : "border-red-500/30 bg-red-500/5")
                }
              >
                <span className="shrink-0 uppercase tracking-wider text-[10px] mt-0.5">
                  {r.state}
                </span>
                <span className="truncate flex-1" title={r.url}>
                  {r.url}
                </span>
                {r.detail && (
                  <span className="text-foreground/55">{r.detail}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        </div>
      </CardContent>
    </Card>
  );
}
