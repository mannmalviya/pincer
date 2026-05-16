"use client";

// PlatformsCard. The /dashboard/settings surface for managing which
// platforms Pincer can post to.
//
// Why it exists: onboarding only asks the user to pick platforms once.
// If they skip Reddit then later decide they want it, there was nowhere
// in the app to connect it without re-running the whole onboarding flow.
// This card closes that loop: it lists every supported platform with its
// current "connected" status, lets the user add the ones they want, and
// drives the same sidecar login flow (Chromium opens, user signs in, we
// flush cookies on finish) for the newly selected platforms only.
//
// State model:
//   - `connected` is the set already in localStorage (from onboarding or
//     a previous run of this card). These show a green pill.
//   - `toAdd` is the user's checkbox selection of platforms to connect.
//     Only non-connected, non-disabled platforms show a checkbox.
//   - The `loginStatus` state machine mirrors BrowserLoginStep in
//     onboarding-wizard.tsx so the visible button/text flow is identical.
//   - On successful /login/finish, we union `toAdd` into the stored
//     selection, then refresh `connected` from localStorage.

import { useEffect, useState } from "react";
import { FaCheck } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  loadSelectedPlatforms,
  saveSelectedPlatforms,
  PLATFORM_META,
  PLATFORM_ORDER,
  type Platform,
} from "@/lib/platforms";

// Same hardcoded sidecar base the onboarding wizard uses. When that becomes
// an env var, swap both call sites at once.
const SIDECAR_BASE = "http://localhost:9000";

// Login state machine. Same labels and transitions as the onboarding
// wizard's BrowserLoginStep so the user has a consistent experience.
type LoginStatus =
  | "idle"
  | "starting-sidecar"
  | "opening"
  | "waiting"
  | "finishing";

export function PlatformsCard() {
  // Currently connected platforms, sourced from localStorage. We hold this
  // in state (rather than re-reading localStorage on every render) so a
  // successful login can refresh the connected list without a full
  // route reload.
  const [connected, setConnected] = useState<Platform[]>([]);

  // Whether we've finished the first localStorage read. Prevents a flash
  // of "no platforms connected" before the read resolves on mount.
  const [hydrated, setHydrated] = useState(false);

  // User's checkbox selection: platforms the user wants to add this run.
  // Reset to empty whenever a connect cycle completes successfully.
  const [toAdd, setToAdd] = useState<Platform[]>([]);

  // /login flow state. `detected` maps each platform-being-connected to a
  // boolean populated by polling /login/status, exactly like onboarding.
  const [loginStatus, setLoginStatus] = useState<LoginStatus>("idle");
  const [detected, setDetected] = useState<Partial<Record<Platform, boolean>>>(
    {},
  );
  const [error, setError] = useState<string | null>(null);
  const [justAdded, setJustAdded] = useState<Platform[] | null>(null);

  // Initial load. localStorage access is client-only; useEffect guards us
  // against SSR even though this whole file is "use client".
  useEffect(() => {
    setConnected(loadSelectedPlatforms());
    setHydrated(true);
  }, []);

  // While we're in the "waiting" state, poll the sidecar to see which of
  // the platforms-being-added have a fresh session cookie. Same 2.5s
  // cadence as onboarding. Stops as soon as we leave "waiting".
  useEffect(() => {
    if (loginStatus !== "waiting") return;
    let cancelled = false;
    const controller = new AbortController();

    async function tick() {
      try {
        const res = await fetch(`${SIDECAR_BASE}/login/status`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platforms: toAdd }),
          signal: controller.signal,
        });
        const data = (await res.json()) as {
          ok: boolean;
          status?: Record<string, boolean>;
        };
        if (cancelled || !data.ok || !data.status) return;
        setDetected(data.status as Partial<Record<Platform, boolean>>);
      } catch {
        // Network errors are expected during startup races; next tick retries.
      }
    }

    tick();
    const handle = window.setInterval(tick, 2500);
    return () => {
      cancelled = true;
      controller.abort();
      window.clearInterval(handle);
    };
  }, [loginStatus, toAdd]);

  // Gate the "I'm done" button on every selected platform showing a tick,
  // mirroring the onboarding wizard's `allDetected` rule.
  const allDetected =
    toAdd.length > 0 && toAdd.every((p) => detected[p]);

  function toggleAdd(p: Platform) {
    setToAdd((cur) =>
      cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
    );
    // Any change to the selection invalidates the current login attempt:
    // status maps were keyed to the old `toAdd` array.
    setDetected({});
    setJustAdded(null);
  }

  async function startConnect() {
    if (toAdd.length === 0) return;
    setError(null);
    setJustAdded(null);

    // 1. Make sure the Python sidecar is up. Idempotent.
    setLoginStatus("starting-sidecar");
    try {
      const startRes = await fetch("/api/sidecar/start", { method: "POST" });
      const startData = await startRes.json();
      if (!startData.ok) {
        setError(startData.error || "Couldn't start the browser sidecar.");
        setLoginStatus("idle");
        return;
      }
    } catch {
      setError(
        "Couldn't reach the dashboard's sidecar control endpoint. Make sure you're running the dashboard with `npm run dev`.",
      );
      setLoginStatus("idle");
      return;
    }

    // 2. Open Chromium with one login tab per platform-being-added.
    setLoginStatus("opening");
    try {
      const res = await fetch(`${SIDECAR_BASE}/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ platforms: toAdd }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to open Chromium.");
        setLoginStatus("idle");
        return;
      }
      setLoginStatus("waiting");
    } catch {
      setError(
        "Sidecar started but didn't respond to the login request. Check the dev terminal for sidecar errors.",
      );
      setLoginStatus("idle");
    }
  }

  async function finishConnect() {
    setError(null);
    setLoginStatus("finishing");
    try {
      const res = await fetch(`${SIDECAR_BASE}/login/finish`, {
        method: "POST",
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.error || "Failed to save the login session.");
        setLoginStatus("waiting");
        return;
      }
      // Persist: union the newly connected platforms into localStorage,
      // dedup, and refresh the displayed `connected` list so the new rows
      // jump to the "connected" section immediately.
      const merged = Array.from(new Set([...connected, ...toAdd])).sort(
        (a, b) => PLATFORM_ORDER.indexOf(a) - PLATFORM_ORDER.indexOf(b),
      );
      saveSelectedPlatforms(merged);
      setConnected(merged);
      setJustAdded(toAdd);
      setToAdd([]);
      setDetected({});
      setLoginStatus("idle");
    } catch {
      setError("Couldn't save the login session.");
      setLoginStatus("waiting");
    }
  }

  // Partition the supported platforms into three buckets so the UI can
  // render them in semantically meaningful groups. "Not yet supported"
  // covers the meta.disabled platforms (no login path implemented),
  // which we surface as informational rows rather than hide entirely.
  const connectedSet = new Set(connected);
  const supported = PLATFORM_ORDER.filter((p) => !PLATFORM_META[p].disabled);
  const connectedList = supported.filter((p) => connectedSet.has(p));
  const addableList = supported.filter((p) => !connectedSet.has(p));
  const disabledList = PLATFORM_ORDER.filter((p) => PLATFORM_META[p].disabled);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-xl tracking-tight">
          Platforms
        </CardTitle>
        <CardDescription>
          Connect more platforms after onboarding. Pincer opens Chromium so
          you can sign in once; we save the session cookies, never your
          password.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {!hydrated && (
          <p className="text-sm text-foreground/55">Loading...</p>
        )}

        {hydrated && (
          <>
            {/* Connected section. Only renders when at least one platform
                is already wired up so the empty state stays clean. */}
            {connectedList.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-mono uppercase tracking-wider text-foreground/55">
                  Connected
                </h3>
                <ul className="flex flex-col gap-2">
                  {connectedList.map((p) => {
                    const meta = PLATFORM_META[p];
                    const Icon = meta.icon;
                    const wasJustAdded = justAdded?.includes(p) === true;
                    return (
                      <li
                        key={p}
                        className={
                          "flex items-center gap-3 p-3 rounded-lg border " +
                          (wasJustAdded
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
                            Cookies saved. Pincer can post and poll comments.
                          </span>
                        </div>
                        <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs">
                          <FaCheck />
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Available-to-add section. Each row is a checkbox-row in
                the same shape onboarding uses. Disabled platforms are
                grouped further down. */}
            {addableList.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-mono uppercase tracking-wider text-foreground/55">
                  Available to add
                </h3>
                <ul className="flex flex-col gap-2">
                  {addableList.map((p) => {
                    const meta = PLATFORM_META[p];
                    const Icon = meta.icon;
                    const checked = toAdd.includes(p);
                    const isDetected = Boolean(detected[p]);
                    const isInFlight =
                      loginStatus !== "idle" && checked;
                    const id = `add-platform-${p}`;
                    return (
                      <li key={p}>
                        <label
                          htmlFor={id}
                          className={
                            "flex items-center gap-3 p-3 rounded-lg border cursor-pointer transition-colors " +
                            (isDetected
                              ? "border-green-500/40 bg-green-500/5"
                              : checked
                                ? "border-[color:var(--brand)] bg-[color:var(--brand)]/5"
                                : "border-foreground/10 hover:border-foreground/30 hover:bg-foreground/5")
                          }
                        >
                          <Checkbox
                            id={id}
                            checked={checked}
                            disabled={loginStatus !== "idle"}
                            onCheckedChange={() => toggleAdd(p)}
                          />
                          <Icon
                            className="shrink-0 text-xl"
                            style={{ color: meta.color }}
                            aria-hidden
                          />
                          <div className="flex flex-col min-w-0 flex-1">
                            <span className="font-medium tracking-tight flex items-center gap-2">
                              {meta.label}
                              {meta.badge && (
                                <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/50 border border-foreground/15 rounded-full px-1.5 py-0.5">
                                  {meta.badge}
                                </span>
                              )}
                            </span>
                            <span className="text-xs text-foreground/55 leading-relaxed">
                              {isInFlight && !isDetected
                                ? "Waiting for sign-in in Chromium..."
                                : isDetected
                                  ? "Signed in. Click the button below to finish."
                                  : meta.tagline}
                            </span>
                          </div>
                          {isDetected && (
                            <span className="shrink-0 inline-flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs">
                              <FaCheck />
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}

            {/* Action / status row for the connect flow. The button shape
                follows the same idle / starting / opening / waiting /
                finishing transitions as onboarding. */}
            {addableList.length > 0 && (
              <div className="flex flex-col gap-2">
                {error && (
                  <p className="text-sm text-red-700 dark:text-red-400">
                    {error}
                  </p>
                )}

                {loginStatus === "idle" && (
                  <Button
                    onClick={startConnect}
                    disabled={toAdd.length === 0}
                    className="self-start"
                  >
                    {toAdd.length === 0
                      ? "Pick a platform to connect"
                      : toAdd.length === 1
                        ? "Connect 1 platform"
                        : `Connect ${toAdd.length} platforms`}
                  </Button>
                )}

                {loginStatus === "starting-sidecar" && (
                  <Button disabled className="self-start">
                    Starting sidecar...
                  </Button>
                )}

                {loginStatus === "opening" && (
                  <Button disabled className="self-start">
                    Opening Chromium...
                  </Button>
                )}

                {loginStatus === "waiting" && (
                  <>
                    <p className="text-sm text-foreground/80">
                      Chromium is open. Sign in to each tab, then click
                      below to save and close.
                    </p>
                    <span
                      className="relative group inline-block self-start"
                      title={
                        allDetected ? undefined : "Sign in to every selected platform"
                      }
                    >
                      <Button
                        onClick={finishConnect}
                        disabled={!allDetected}
                        className={
                          !allDetected ? "pointer-events-none opacity-60" : ""
                        }
                      >
                        I&apos;m done signing in
                      </Button>
                    </span>
                  </>
                )}

                {loginStatus === "finishing" && (
                  <Button disabled className="self-start">
                    Saving session...
                  </Button>
                )}
              </div>
            )}

            {/* "Nothing left to add" empty state. Reads as success copy
                when everything supported is already wired up. */}
            {addableList.length === 0 && connectedList.length > 0 && (
              <p className="text-sm text-foreground/55">
                Every supported platform is connected.
              </p>
            )}

            {/* Disabled-platform list. Informational so the user can see
                what's on the roadmap without it cluttering the actionable
                section above. */}
            {disabledList.length > 0 && (
              <section className="flex flex-col gap-2">
                <h3 className="text-xs font-mono uppercase tracking-wider text-foreground/55">
                  Not yet supported
                </h3>
                <ul className="flex flex-col gap-2">
                  {disabledList.map((p) => {
                    const meta = PLATFORM_META[p];
                    const Icon = meta.icon;
                    return (
                      <li
                        key={p}
                        className="flex items-center gap-3 p-3 rounded-lg border border-foreground/10 opacity-60"
                      >
                        <Icon
                          className="shrink-0 text-xl"
                          style={{ color: meta.color }}
                          aria-hidden
                        />
                        <div className="flex flex-col min-w-0 flex-1">
                          <span className="font-medium tracking-tight flex items-center gap-2">
                            {meta.label}
                            {meta.badge && (
                              <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/50 border border-foreground/15 rounded-full px-1.5 py-0.5">
                                {meta.badge}
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-foreground/55 leading-relaxed">
                            Coming later. Currently no login or posting
                            path.
                          </span>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              </section>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
