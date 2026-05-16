"use client";

import { useEffect, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { fetchStats, type AgentStats } from "@/lib/agent";

// OverviewStats, the three-card metrics row at the top of /dashboard.
//
// Client component because:
//   1. It polls the agent every 30s for fresh counts.
//   2. The agent URL is read from a public env var at request time.
//   3. We want graceful "agent offline" rendering (a dash instead of 0)
//      without blocking the rest of the page's server render.
//
// The poll interval is intentionally polite: the dashboard is a single-user
// app, and the watch loop on the agent ticks every 60s anyway, so anything
// faster than ~30s just hammers the agent for no visual gain.
const POLL_INTERVAL_MS = 30_000;

export function OverviewStats() {
  const [stats, setStats] = useState<AgentStats | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const refresh = async () => {
      const next = await fetchStats();
      if (cancelled) return;
      setStats(next);
      setLoaded(true);
    };

    void refresh();
    const id = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  // Display rule: before the first response we show a quiet dash so the
  // page doesn't flicker from 0 to N when the agent answers. After we've
  // gotten one response (loaded === true) we trust it; agent-offline
  // (stats === null) also renders dashes so the user can tell the
  // difference between "really zero" and "data unavailable".
  const display = (value: number | undefined): string =>
    !loaded || stats === null ? "—" : String(value ?? 0);

  return (
    <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <Stat label="Posts live" value={display(stats?.posts_watching)} />
      <Stat
        label="Pending replies"
        value={display(stats?.pending_replies)}
      />
      <Stat
        label="Comments tracked"
        value={display(stats?.comments_tracked)}
      />
    </section>
  );
}

// Stat, one big number plus caption. Local to this client component so we
// don't have to thread the mono-number styling through two files. The
// number font is mono so digit widths align across cards as values change.
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardContent className="py-6">
        <p className="text-xs uppercase tracking-wider text-foreground/50">
          {label}
        </p>
        <p className="font-mono text-3xl mt-2">{value}</p>
      </CardContent>
    </Card>
  );
}
