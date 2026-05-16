// Placeholder — backed by `analytics_snapshots` once the 5-minute capture
// loop is running. Charts will use recharts per PLAN.md.

import { PlaceholderSection } from "../_components/placeholder-section";

export default function AnalyticsPage() {
  return (
    <PlaceholderSection
      label="Analytics"
      title="See what's catching fire."
      body="Upvotes, views, and comment velocity per platform, sampled every five minutes. Includes Hacker News read-only via the Algolia search API once the analytics snapshot loop is online."
    />
  );
}
