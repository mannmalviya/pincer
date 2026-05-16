"use client";

import { useEffect, useState } from "react";

import { AGENT_BASE, pingAgent } from "@/lib/agent";

// AgentStatusHero replaces the static "Pincer is standing by" headline on
// /dashboard with a live health check of the Brev-deployed agent. Polls
// /health every 10s; renders three states:
//
//   loading  — first probe in flight. Neutral copy, no dot color.
//   online   — agent reachable. Green dot, "Pincer is online."
//   offline  — agent unreachable. Red dot, "Pincer is offline." +
//              the configured AGENT_BASE so the user can diagnose.
//
// Faster cadence than stats/comments (10s vs 30s) because connectivity
// flips are what the user actually wants visibility into; the cost is
// one HEAD-shaped request per 10s, negligible.
const POLL_INTERVAL_MS = 10_000;

type Status = "loading" | "online" | "offline";

export function AgentStatusHero() {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;

    async function probe() {
      const ok = await pingAgent();
      if (cancelled) return;
      setStatus(ok ? "online" : "offline");
    }

    void probe();
    const id = setInterval(() => void probe(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const dotClass =
    status === "online"
      ? "bg-green-500 shadow-[0_0_12px_-1px_rgba(34,197,94,0.7)]"
      : status === "offline"
        ? "bg-red-500 shadow-[0_0_12px_-1px_rgba(239,68,68,0.7)]"
        : "bg-foreground/30";

  const headline =
    status === "online"
      ? "Pincer agent is live."
      : status === "offline"
        ? "Pincer agent is offline."
        : "Checking Pincer agent...";

  const subline =
    status === "online"
      ? "Watching your posts and pulling comments on schedule."
      : status === "offline"
        ? `Cannot reach ${AGENT_BASE}. Confirm the Brev instance is running.`
        : "Probing the agent for a heartbeat.";

  return (
    <section>
      <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
        Overview
      </p>
      <h1 className="font-serif text-4xl sm:text-5xl tracking-tight leading-[1.05] mt-2 flex items-center gap-4 flex-wrap">
        <span
          className={
            "inline-block w-3 h-3 rounded-full shrink-0 transition-colors " +
            dotClass
          }
          aria-hidden
        />
        <span>{headline}</span>
      </h1>
      <p className="text-foreground/70 mt-3 max-w-xl leading-relaxed">
        {subline}
      </p>
    </section>
  );
}
