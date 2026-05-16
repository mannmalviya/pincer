import { AgentStatusHero } from "./_components/agent-status-hero";
import { CommentsFeed } from "./_components/comments-feed";
import { OverviewStats } from "./_components/overview-stats";

// ---------------------------------------------------------------------------
// /dashboard — Overview.
//
// First thing users see after onboarding. Shows the agent health hero, the
// headline counters (posts, pending escalations, comments tracked), and a
// flat feed of every comment captured across watched posts.
// ---------------------------------------------------------------------------
export default function DashboardOverview() {
  return (
    <div className="flex flex-col gap-12">
      {/* Hero, live agent health check. Replaces the static placeholder
          with a 10s /health poll against the Brev-deployed agent. */}
      <AgentStatusHero />

      {/* Top-line metrics. Client component, polls the agent's /stats every
          30s, falls back to dashes when the agent is unreachable. */}
      <OverviewStats />

      {/* Flat feed of every comment the agent has captured across every
          watched post. Polls /comments on the same 30s cadence as stats. */}
      <CommentsFeed />
    </div>
  );
}