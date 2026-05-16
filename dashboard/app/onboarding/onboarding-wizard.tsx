"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FaCheck } from "react-icons/fa6";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AGENT_BASE,
  analyzeRepo,
  saveOnboardingAnswers,
} from "@/lib/agent";
import {
  PLATFORM_META,
  PLATFORM_ORDER,
  saveSelectedPlatforms,
  type Platform,
} from "@/lib/platforms";

// ---------------------------------------------------------------------------
// OnboardingWizard — two-step setup flow.
//
// Step 0  — "Where do you want to launch?" multi-select across the six
//           supported platforms. The selection drives which login tabs
//           open in step 1.
//
// Step 1  — Browser login. Calls the local Playwright sidecar
//           (browser-sidecar/app.py) to spawn a Chromium window with one
//           login tab per selected platform. The user signs in manually,
//           then triggers /login/finish to save cookies to the persistent
//           profile. Future post calls reuse those cookies.
//
// Sidecar must be running at http://localhost:9000 before step 1 starts.
// Reachable as part of the dev workflow: `uv run uvicorn app:app --port 9000`
// from the browser-sidecar/ directory.
// ---------------------------------------------------------------------------

// Base URL for the local browser-sidecar. Hardcoded for dev. When we
// deploy, this becomes an env var that the laptop-side worker reads.
const SIDECAR_BASE = "http://localhost:9000";

export function OnboardingWizard() {
  const router = useRouter();

  // Which platforms the user has chosen on step 0.
  const [selected, setSelected] = useState<Platform[]>([]);

  // Whether the user has successfully completed the browser-login step.
  // Reset to false any time `selected` changes — the cookies we saved are
  // for a specific set of platforms; if that set changes, the user needs
  // to log in again to cover the new ones.
  const [loginComplete, setLoginComplete] = useState(false);

  // Step navigation. Steps are just two: 'select' then 'browser-login'.
  // We never skip 'browser-login' because every platform Pincer supports
  // needs cookies (we use browser automation, not API tokens, everywhere).
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // Backfill URLs the user pasted on the optional step 2. Empty list is
  // valid (skip). Each entry gets POSTed to the agent's /posts on finish.
  const [backfillUrls, setBackfillUrls] = useState("");

  // Project step state. The repo URL + optional PAT go to /onboarding/analyze;
  // the agent clones, summarizes, and returns 4-6 questions. The user fills
  // them in; on Next we POST to /onboarding/answers. Marked done once the
  // agent has accepted the answers — until then we don't advance.
  const [repoUrl, setRepoUrl] = useState("");
  const [repoToken, setRepoToken] = useState("");
  const [projectSummary, setProjectSummary] = useState<string | null>(null);
  const [projectQuestions, setProjectQuestions] = useState<string[]>([]);
  const [projectAnswers, setProjectAnswers] = useState<string[]>([]);
  const [projectDone, setProjectDone] = useState(false);

  const steps: Array<"project" | "project" | "select" | "browser-login" | "backfill"> = [
    "project",
    ...(projectDone ? (["select"] as const) : []),
    ...(projectDone && selected.length > 0
      ? (["browser-login", "backfill"] as const)
      : []),
  ];

  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;

  // Selection step is valid once anything is checked; login step is valid
  // once /login/finish returned ok. Backfill is always valid (skippable).
  const currentValid =
    currentStep === "project"
      ? projectDone
      : currentStep === "select"
        ? selected.length > 0
        : currentStep === "browser-login"
          ? loginComplete
          : currentStep === "backfill"
            ? true
            : false;

  function togglePlatform(p: Platform) {
    setSelected((cur) =>
      cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
    );
    // Selection changed → invalidate any prior login. If the user logged
    // into Reddit + HN then went back and added Discord, they need to log
    // into Discord now too. Forcing a re-login keeps the saved profile
    // consistent with the user's current intent.
    setLoginComplete(false);
  }

  async function handleFinish() {
    setSubmitting(true);
    try {
      // Stash the user's selection in localStorage so the New Post page
      // knows which platforms to offer as publish targets. Cookies for
      // those same platforms already live in the sidecar's profile dir
      // (saved during /login/finish), so the two pieces of state pair up:
      // the cookies enable posting, the localStorage flag drives the UI.
      saveSelectedPlatforms(selected);

      // Fan out one POST /posts per backfill URL. Errors per URL are
      // swallowed; the agent returns duplicate:true on collision so
      // re-running onboarding doesn't blow up. We deliberately don't block
      // the redirect on these completing; the watch loop will pick them
      // up on its next tick regardless.
      const urls = backfillUrls
        .split(/\s+/)
        .map((u) => u.trim())
        .filter((u) => u.length > 0);
      if (urls.length > 0) {
        await Promise.all(
          urls.map((url) =>
            fetch(`${AGENT_BASE}/posts`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ url, source: "backfill", watch: true }),
            }).catch(() => {}),
          ),
        );
      }

      router.push("/dashboard");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator steps={steps} current={stepIndex} />

      {currentStep === "project" && (
        <ProjectStep
          repoUrl={repoUrl}
          setRepoUrl={setRepoUrl}
          repoToken={repoToken}
          setRepoToken={setRepoToken}
          summary={projectSummary}
          setSummary={setProjectSummary}
          questions={projectQuestions}
          setQuestions={setProjectQuestions}
          answers={projectAnswers}
          setAnswers={setProjectAnswers}
          done={projectDone}
          setDone={setProjectDone}
        />
      )}

      {currentStep === "select" && (
        <SelectStep selected={selected} onToggle={togglePlatform} />
      )}

      {currentStep === "browser-login" && (
        <BrowserLoginStep
          platforms={selected}
          loginComplete={loginComplete}
          onLoginComplete={() => setLoginComplete(true)}
        />
      )}

      {currentStep === "backfill" && (
        <BackfillStep value={backfillUrls} onChange={setBackfillUrls} />
      )}

      {/* Footer nav — Cancel on first step, Back otherwise; Next/Finish on the right. */}
      <div className="flex justify-between">
        {stepIndex === 0 ? (
          <Link href="/" className={buttonVariants({ variant: "ghost" })}>
            Cancel
          </Link>
        ) : (
          <Button
            variant="ghost"
            onClick={() => setStepIndex((s) => s - 1)}
          >
            ← Back
          </Button>
        )}

        {isLastStep ? (
          <Button onClick={handleFinish} disabled={!currentValid || submitting}>
            {submitting ? "Saving..." : "Finish setup →"}
          </Button>
        ) : (
          <Button
            onClick={() => setStepIndex((s) => s + 1)}
            disabled={!currentValid}
          >
            Next →
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator — small mono dotline above the active card.
// Renders "01 · Select", "02 · Login", etc. Highlights the active step,
// fades done/upcoming.
// ---------------------------------------------------------------------------
function StepIndicator({
  steps,
  current,
}: {
  steps: Array<"project" | "select" | "browser-login" | "backfill">;
  current: number;
}) {
  const stepLabel: Record<"project" | "select" | "browser-login" | "backfill", string> = {
    project: "Project",
    select: "Select",
    "browser-login": "Login",
    backfill: "Backfill",
  };

  return (
    <ol className="flex items-center gap-3 flex-wrap text-xs font-mono text-foreground/40">
      {steps.map((s, i) => {
        const active = i === current;
        const done = i < current;
        return (
          <li key={`${s}-${i}`} className="flex items-center gap-3">
            <span
              className={
                active
                  ? "text-foreground"
                  : done
                    ? "text-foreground/70"
                    : "text-foreground/40"
              }
            >
              {String(i + 1).padStart(2, "0")} · {stepLabel[s]}
            </span>
            {i < steps.length - 1 && (
              <span className="w-6 h-px bg-foreground/15" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Step 0 — platform multi-select.
// Grid of clickable cards. Clicked card flips the platform in/out of the
// `selected` array; visual state shows an orange dot + brand-tinted border.
// ---------------------------------------------------------------------------
function SelectStep({
  selected,
  onToggle,
}: {
  selected: Platform[];
  onToggle: (p: Platform) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-2xl tracking-tight">
          Where do you want to launch?
        </CardTitle>
        <CardDescription>
          Pick every platform Pincer should post on. You can change this
          later from Settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PLATFORM_ORDER.map((p) => {
            const meta = PLATFORM_META[p];
            const checked = selected.includes(p);
            const isDisabled = meta.disabled === true;
            const id = `platform-${p}`;
            const Icon = meta.icon;
            return (
              <li key={p}>
                {/* The whole row is one click target. <label htmlFor> wires
                    label-click → checkbox-toggle natively. Tabbing into the
                    checkbox still works because it's a real input under the
                    hood (base-ui Root). Disabled rows render with reduced
                    opacity, drop the hover affordance, and the checkbox
                    refuses input, so click-anywhere on the row is a no-op. */}
                <label
                  htmlFor={id}
                  aria-disabled={isDisabled || undefined}
                  className={
                    "flex items-center gap-3 p-4 rounded-xl border transition-colors " +
                    (isDisabled
                      ? "border-foreground/10 opacity-50 cursor-not-allowed"
                      : "cursor-pointer " +
                        (checked
                          ? "border-[color:var(--brand)] bg-[color:var(--brand)]/5"
                          : "border-foreground/10 hover:border-foreground/30 hover:bg-foreground/5"))
                  }
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    disabled={isDisabled}
                    onCheckedChange={() => {
                      if (isDisabled) return;
                      onToggle(p);
                    }}
                  />

                  {/* Brand glyph in the platform's official color. */}
                  <Icon
                    className="shrink-0 text-2xl"
                    style={{ color: meta.color }}
                  />

                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-semibold tracking-tight flex items-center gap-2">
                      {meta.label}
                      {meta.badge && (
                        <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/50 border border-foreground/15 rounded-full px-1.5 py-0.5">
                          {meta.badge}
                        </span>
                      )}
                    </span>
                    <span className="text-sm text-foreground/65 leading-relaxed">
                      {meta.tagline}
                    </span>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — browser-login.
//
// Drives the sidecar's /login/start and /login/finish endpoints. The user
// goes through three states in order:
//
//   idle    — initial. "Open Chromium" button visible.
//   waiting — /login/start succeeded; Chromium is open with login tabs.
//             "I'm done logging in" button visible. User logs in manually
//             in the Chromium window during this state.
//   done    — /login/finish succeeded. Session cookies are persisted.
//             The wizard footer's "Finish setup" button enables.
//
// Errors at any step return us to the previous interactive state with an
// inline message — never silently swallow.
// ---------------------------------------------------------------------------
function BrowserLoginStep({
  platforms,
  loginComplete,
  onLoginComplete,
}: {
  platforms: Platform[];
  loginComplete: boolean;
  onLoginComplete: () => void;
}) {
  const [status, setStatus] = useState<
    "idle" | "starting-sidecar" | "opening" | "waiting" | "finishing"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  // Per-platform "are they signed in?" map, populated by the polling
  // effect below. We don't pre-seed keys, so a missing entry reads as
  // "not detected yet" — same UX as false but the distinction is useful
  // for debugging in the network panel.
  const [detected, setDetected] = useState<Partial<Record<Platform, boolean>>>(
    {},
  );

  // `allDetected` gates the "I'm done logging in" button. The user
  // explicitly asked for this: until every platform shows a tick, the
  // button stays disabled and a hover tooltip explains why.
  const allDetected =
    platforms.length > 0 && platforms.every((p) => detected[p]);

  // Poll the sidecar's /login/status while Chromium is open. Cookie
  // checks are free; URL fallbacks only fire when the cookie is missing,
  // so 2.5s is a comfortable cadence without hammering the platform APIs.
  // The polling stops the moment we leave the "waiting" state (button
  // click, error, finish).
  useEffect(() => {
    if (status !== "waiting") return;
    let cancelled = false;
    const controller = new AbortController();

    async function tick() {
      try {
        const res = await fetch(`${SIDECAR_BASE}/login/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platforms }),
          signal: controller.signal,
        });
        const data = (await res.json()) as {
          ok: boolean;
          status?: Record<string, boolean>;
        };
        if (cancelled || !data.ok || !data.status) return;
        // Replace, not merge: the latest tick is the truth. If a
        // previously-detected platform flips back to false (user signed
        // out mid-flow), we want the row to revert.
        setDetected(data.status as Partial<Record<Platform, boolean>>);
      } catch {
        // Network errors are expected during the startup race window
        // and during finish. Swallow them — next tick will retry.
      }
    }

    // Fire one immediately so the user doesn't sit through a 2.5s wait
    // for the first reading, then poll on the interval.
    tick();
    const handle = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(handle);
    };
  }, [status, platforms]);

  async function openLogin() {
    setError(null);

    // Step 1: ensure the Python sidecar is running. /api/sidecar/start is a
    // Next.js route handler that probes /health and spawns uvicorn if needed.
    // Idempotent — does nothing if the sidecar is already up.
    setStatus("starting-sidecar");
    try {
      const startRes = await fetch("/api/sidecar/start", { method: "POST" });
      const startData = await startRes.json();
      if (!startData.ok) {
        setError(startData.error || "Couldn't start the browser sidecar.");
        setStatus("idle");
        return;
      }
    } catch {
      setError(
        "Couldn't reach the dashboard's sidecar control endpoint. " +
          "Make sure you're running this from `npm run dev` in the dashboard/ folder.",
      );
      setStatus("idle");
      return;
    }

    // Step 2: ask the sidecar to open Chromium with login tabs for the
    // user's selected platforms. The Chromium window stays open until
    // finishLogin() calls /login/finish.
    setStatus("opening");
    try {
      const res = await fetch(`${SIDECAR_BASE}/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to open Chromium");
        setStatus("idle");
        return;
      }
      setStatus("waiting");
    } catch {
      setError(
        "Sidecar started but didn't respond to the login request. " +
          "Check the dev server terminal for sidecar errors.",
      );
      setStatus("idle");
    }
  }

  async function finishLogin() {
    setError(null);
    setStatus("finishing");
    try {
      const res = await fetch(`${SIDECAR_BASE}/login/finish`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to save login session");
        setStatus("waiting");
        return;
      }
      onLoginComplete();
      // Leave status as "finishing" — parent's loginComplete=true will
      // change which UI block renders below.
    } catch {
      setError("Couldn't save the login session.");
      setStatus("waiting");
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-2xl tracking-tight">
          Log in to your platforms
        </CardTitle>
        <CardDescription>
          We&apos;ll open a new Chromium window with one login tab per platform
          you selected.
        </CardDescription>
        <CardDescription>
          Sign in like you normally would. If you don&apos;t have an account
          yet, sign up.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Account-choice callout. Tinted box, brand-colored, so the
            "which account?" guidance reads as actionable advice rather
            than blending into the rest of the description copy. */}
        <div className="rounded-lg p-3 bg-[color:var(--brand)]/10 border border-[color:var(--brand)]/25 text-sm text-foreground/75 leading-relaxed">
          If you don&apos;t have an account yet, sign up. Use the account that
          represents the product you&apos;re marketing, since that&apos;s the
          one Pincer will post from.
        </div>

        {/* The set of platforms whose login tabs will be opened. While
            Chromium is open we poll /login/status and flip each row to a
            "signed in" state the moment its auth cookie shows up. Rows
            never down-grade once green to avoid flicker if a poll briefly
            misses (e.g. mid-redirect). */}
        <ul className="flex flex-col gap-2">
          {platforms.map((p) => {
            const meta = PLATFORM_META[p];
            const Icon = meta.icon;
            const isDetected = Boolean(detected[p]);
            return (
              <li
                key={p}
                className={
                  "flex items-center gap-3 p-3 rounded-lg border transition-colors " +
                  (isDetected
                    ? "border-green-500/40 bg-green-500/5"
                    : "border-foreground/10 bg-foreground/[0.02]")
                }
              >
                <Icon
                  className="shrink-0 text-xl"
                  style={{ color: meta.color }}
                  aria-hidden
                />
                <div className="flex flex-col min-w-0 flex-1">
                  <span className="font-medium tracking-tight">
                    {meta.label}
                  </span>
                  <span className="text-xs text-foreground/55 leading-relaxed">
                    {isDetected
                      ? "Signed in. You can move on whenever you're ready."
                      : "Sign in (or create an account) in the tab that opens."}
                  </span>
                </div>
                {/* Tick badge. Pure visual confirmation, mirrors the
                    "signed in" copy in the row description. */}
                {isDetected && (
                  <span
                    className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs"
                    aria-label="Signed in"
                  >
                    <FaCheck />
                  </span>
                )}
              </li>
            );
          })}
        </ul>

        {/* Trust note — typed once here so the user understands what we save
            vs. what stays inside the platform. */}
        <p className="text-sm text-foreground/65 leading-relaxed border-l-2 border-[color:var(--brand)] pl-3">
          Your password is typed directly into each platform&apos;s own
          login page. Pincer never sees it. We only save the session
          cookies the platform gives your browser, so future posts can
          run without re-prompting.
        </p>

        {/* Action / status area. The button visible depends on `status`. */}
        <div className="flex flex-col gap-3">
          {!loginComplete && status === "idle" && (
            <Button onClick={openLogin} className="self-start">
              Open Chromium →
            </Button>
          )}

          {status === "starting-sidecar" && (
            <Button disabled className="self-start">
              Starting sidecar...
            </Button>
          )}

          {status === "opening" && (
            <Button disabled className="self-start">
              Opening Chromium...
            </Button>
          )}

          {status === "waiting" && (
            <>
              <p className="text-sm text-foreground/85">
                Chromium is open. Log in to each tab, then click below
                to save and close.
              </p>
              {/* The button stays disabled until every platform shows a
                  tick. The wrapping span captures hover even while the
                  underlying button is disabled (browsers swallow hover
                  events on disabled buttons), so the tooltip surfaces. */}
              <span
                className="relative group inline-block self-start"
                title={
                  allDetected ? undefined : "Log in to all platforms"
                }
              >
                <Button
                  onClick={finishLogin}
                  disabled={!allDetected}
                  className={
                    !allDetected ? "pointer-events-none opacity-60" : ""
                  }
                >
                  I&apos;m done logging in →
                </Button>
                {!allDetected && (
                  <span
                    role="tooltip"
                    className={
                      "pointer-events-none absolute left-1/2 -translate-x-1/2 bottom-full mb-2 " +
                      "whitespace-nowrap rounded-md bg-foreground text-background " +
                      "px-2 py-1 text-xs shadow opacity-0 group-hover:opacity-100 " +
                      "transition-opacity"
                    }
                  >
                    Log in to all platforms
                  </span>
                )}
              </span>
            </>
          )}

          {status === "finishing" && !loginComplete && (
            <Button disabled className="self-start">
              Saving session...
            </Button>
          )}

          {loginComplete && (
            <p className="text-sm text-foreground/85 font-medium">
              Session saved. Click &ldquo;Finish setup&rdquo; below to
              continue to the dashboard.
            </p>
          )}

          {error && (
            <p className="text-sm text-red-700 dark:text-red-400 leading-relaxed">
              {error}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 2 (optional) — backfill existing posts.
//
// User pastes one URL per line (Reddit or HN). On Finish the wizard fans out
// one POST /posts per URL with source:"backfill". The agent parses, seeds an
// initial snapshot + comments, and the watch loop picks them up from there.
// Skipping is fine; leave the textarea empty and click Finish.
// ---------------------------------------------------------------------------
function BackfillStep({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const count = value
    .split(/\s+/)
    .map((u) => u.trim())
    .filter((u) => u.length > 0).length;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-2xl tracking-tight">
          Watch your old posts?
        </CardTitle>
        <CardDescription>
          Paste links to any existing Reddit or Hacker News posts you want
          Pincer to track. One URL per line. Optional, you can skip this and
          add posts later.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <textarea
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={6}
          spellCheck={false}
          placeholder={
            "https://www.reddit.com/r/SideProject/comments/abc123/...\n" +
            "https://news.ycombinator.com/item?id=12345678"
          }
          className="w-full rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm leading-relaxed resize-y focus:outline-none focus:border-foreground/40"
        />
        <p className="text-xs text-foreground/55 font-mono">
          {count === 0
            ? "No URLs yet. Click Finish to skip."
            : `${count} URL${count === 1 ? "" : "s"} ready to backfill.`}
        </p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step 0 (new first step) — project analysis.
//
// User pastes a GitHub repo URL (optionally with a PAT for private repos).
// The agent clones, samples README + key source files, and asks Nemotron
// to produce a one-sentence project summary plus 4-6 clarifying questions.
// The user answers those questions; on submit we POST to /onboarding/answers
// and unlock the rest of the wizard. The reply route later reads the
// summary + Q/A back into the LLM prompt so drafted replies stay grounded.
// ---------------------------------------------------------------------------
function ProjectStep({
  repoUrl,
  setRepoUrl,
  repoToken,
  setRepoToken,
  summary,
  setSummary,
  questions,
  setQuestions,
  answers,
  setAnswers,
  done,
  setDone,
}: {
  repoUrl: string;
  setRepoUrl: (v: string) => void;
  repoToken: string;
  setRepoToken: (v: string) => void;
  summary: string | null;
  setSummary: (v: string | null) => void;
  questions: string[];
  setQuestions: (v: string[]) => void;
  answers: string[];
  setAnswers: (v: string[]) => void;
  done: boolean;
  setDone: (v: boolean) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [savingAnswers, setSavingAnswers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleAnalyze() {
    setError(null);
    setAnalyzing(true);
    setDone(false);
    const res = await analyzeRepo(repoUrl.trim(), repoToken.trim() || undefined);
    if (!res.ok) {
      setError(res.message);
      setAnalyzing(false);
      return;
    }
    setSummary(res.summary);
    setQuestions(res.questions);
    setAnswers(new Array(res.questions.length).fill(""));
    setAnalyzing(false);
  }

  async function handleSaveAnswers() {
    setError(null);
    setSavingAnswers(true);
    const ok = await saveOnboardingAnswers(
      questions.map((q, i) => ({ question: q, answer: answers[i] ?? "" })),
    );
    setSavingAnswers(false);
    if (!ok) {
      setError("Could not save answers. Is the agent reachable?");
      return;
    }
    setDone(true);
  }

  const allAnswered =
    questions.length > 0 && answers.every((a) => a.trim().length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-2xl tracking-tight">
          Tell Pincer about your project
        </CardTitle>
        <CardDescription>
          Paste your GitHub repo. Pincer reads your README + a few source
          files and asks you a handful of questions so drafted replies stay
          on-brand.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Repo URL</span>
          <input
            type="url"
            value={repoUrl}
            onChange={(e) => setRepoUrl(e.target.value)}
            placeholder="https://github.com/your-handle/your-project"
            disabled={analyzing || done}
            className="rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:border-foreground/40 disabled:opacity-60"
          />
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">
            GitHub token{" "}
            <span className="text-foreground/55 font-normal">(optional, private repos only)</span>
          </span>
          <input
            type="password"
            value={repoToken}
            onChange={(e) => setRepoToken(e.target.value)}
            placeholder="github_pat_..."
            disabled={analyzing || done}
            className="rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:border-foreground/40 disabled:opacity-60"
          />
          <span className="text-xs text-foreground/55 leading-relaxed">
            Used once to clone, never stored. Read-only `contents` scope is
            enough.
          </span>
        </label>

        <div className="flex items-center justify-between gap-3">
          {error && (
            <p className="text-xs text-red-700 dark:text-red-400 font-mono">
              {error}
            </p>
          )}
          {summary === null && (
            <Button
              onClick={handleAnalyze}
              disabled={analyzing || repoUrl.trim().length === 0}
              className="ml-auto"
            >
              {analyzing ? "Analyzing..." : "Analyze repo"}
            </Button>
          )}
        </div>

        {summary !== null && (
          <div className="rounded-lg border border-foreground/10 bg-foreground/[0.02] p-3 flex flex-col gap-2">
            <p className="text-xs uppercase tracking-wider text-foreground/55 font-mono">
              What Pincer thinks your project does
            </p>
            <p className="text-sm leading-relaxed">{summary}</p>
          </div>
        )}

        {questions.length > 0 && (
          <div className="flex flex-col gap-4">
            <p className="text-xs uppercase tracking-wider text-foreground/55 font-mono">
              A few quick questions
            </p>
            {questions.map((q, i) => (
              <label key={`${i}-${q.slice(0, 20)}`} className="flex flex-col gap-1">
                <span className="text-sm">{q}</span>
                <textarea
                  value={answers[i] ?? ""}
                  onChange={(e) => {
                    const next = [...answers];
                    next[i] = e.target.value;
                    setAnswers(next);
                  }}
                  rows={2}
                  disabled={savingAnswers || done}
                  className="rounded-lg border border-foreground/15 bg-background px-3 py-2 text-sm focus:outline-none focus:border-foreground/40 resize-y disabled:opacity-60"
                />
              </label>
            ))}

            {!done && (
              <div className="flex items-center justify-end">
                <Button
                  onClick={handleSaveAnswers}
                  disabled={!allAnswered || savingAnswers}
                >
                  {savingAnswers ? "Saving..." : "Save and continue"}
                </Button>
              </div>
            )}

            {done && (
              <p className="text-sm text-foreground/85">
                Saved. Click Next below to pick the platforms Pincer should
                launch on.
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
