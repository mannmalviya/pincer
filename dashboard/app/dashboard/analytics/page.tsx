"use client";

// Analytics page. Renders a green daily-traction bar chart plus a
// comment-velocity line chart and a stats strip, all filterable by
// platform. The agent doesn't yet expose historical snapshots, so we
// derive a 14-day window from the live posts list: each post's
// posted_at lands it in a day bucket, and its latest_snapshot score +
// comment_count fold into that bucket's totals. The bars therefore
// represent "how much traction your posts from that day are carrying
// right now" rather than per-day deltas, which is the most honest read
// we can give without a snapshot history.
//
// Charts are inline SVG so we don't pull recharts in for the hackathon
// demo. Tailwind handles layout; brand green for the traction bars,
// brand orange for the comment line. Empty state stays quiet, with a
// single line telling the user we'll fill in once posts exist.

import { useEffect, useMemo, useState } from "react";

import { Card, CardContent } from "@/components/ui/card";
import { fetchPosts, type AgentPost } from "@/lib/agent";
import {
  PLATFORM_META,
  PLATFORM_ORDER,
  type Platform,
} from "@/lib/platforms";

// Number of days to render in the bar chart. 14 keeps the bars wide
// enough to read at typical dashboard widths without scrolling.
const WINDOW_DAYS = 14;

// One day's worth of aggregated traction for the bar + line charts.
type DayBucket = {
  // Midnight (local) for the bucket, used as the x-axis label.
  date: Date;
  // Sum of latest_snapshot.score across posts published this day.
  // Reddit upvotes / HN points / Bluesky reposts all fold into this.
  traction: number;
  // Sum of latest_snapshot.comment_count for the same posts.
  comments: number;
  // Number of posts published this day (shown in tooltip / under bar).
  posts: number;
};

// Build the 14-day window ending today, then fold each post into its
// bucket. Posts without a posted_at (manual entries pre-fetch) get
// dropped from the chart; they still count toward the stats strip.
function bucketize(posts: AgentPost[]): DayBucket[] {
  const buckets: DayBucket[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // Build the empty window first so days with zero posts still render
  // (a flat bar gap reads as "we did nothing that day", which is
  // information).
  for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    buckets.push({ date: d, traction: 0, comments: 0, posts: 0 });
  }

  for (const post of posts) {
    const ts = post.posted_at ?? post.created_at;
    if (!ts) continue;
    const postDay = new Date(ts * 1000);
    postDay.setHours(0, 0, 0, 0);
    const idx = buckets.findIndex(
      (b) => b.date.getTime() === postDay.getTime(),
    );
    if (idx === -1) continue;
    buckets[idx].posts += 1;
    if (post.latest_snapshot) {
      buckets[idx].traction += post.latest_snapshot.score;
      buckets[idx].comments += post.latest_snapshot.comment_count;
    }
  }

  return buckets;
}

// All platforms that show up in real post data. We narrow the filter
// pills to the same set as AgentPost["platform"] so the user can't
// pick a platform they have no posts for.
const FILTERABLE: Platform[] = ["reddit", "hn", "bluesky"];

export default function AnalyticsPage() {
  const [posts, setPosts] = useState<AgentPost[] | null>(null);
  const [platform, setPlatform] = useState<Platform | "all">("all");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    fetchPosts().then((p) => {
      if (cancelled) return;
      setPosts(p);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Filter then bucket. useMemo so resizing or pill flicker doesn't
  // recompute the whole pipeline.
  const filteredPosts = useMemo(() => {
    if (!posts) return [];
    if (platform === "all") return posts;
    return posts.filter((p) => p.platform === platform);
  }, [posts, platform]);

  const buckets = useMemo(() => bucketize(filteredPosts), [filteredPosts]);

  // Stats strip totals. These run on the filtered set so the numbers
  // match what the charts are showing.
  const totals = useMemo(() => {
    let traction = 0;
    let comments = 0;
    for (const p of filteredPosts) {
      if (p.latest_snapshot) {
        traction += p.latest_snapshot.score;
        comments += p.latest_snapshot.comment_count;
      }
    }
    return {
      posts: filteredPosts.length,
      traction,
      comments,
    };
  }, [filteredPosts]);

  return (
    <main className="flex-1 px-6 py-10">
      <div className="max-w-6xl mx-auto flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="font-serif text-3xl tracking-tight">Analytics</h1>
          <p className="text-sm text-foreground/65">
            Daily traction across every post Pincer is watching. Pick a
            platform to narrow the view.
          </p>
        </header>

        {/* Platform filter. "All" sits first so the default state is
            obvious; per-platform pills inherit their brand color on the
            active state so the user can scan visually. */}
        <div className="flex flex-wrap gap-2">
          <FilterPill
            active={platform === "all"}
            onClick={() => setPlatform("all")}
            label="All platforms"
          />
          {FILTERABLE.map((p) => {
            const meta = PLATFORM_META[p];
            const Icon = meta.icon;
            return (
              <FilterPill
                key={p}
                active={platform === p}
                onClick={() => setPlatform(p)}
                label={meta.label}
                color={meta.color}
                icon={<Icon style={{ color: meta.color }} />}
              />
            );
          })}
        </div>

        <StatsStrip totals={totals} />

        <Card>
          <CardContent className="p-6 flex flex-col gap-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="font-serif text-xl tracking-tight">
                  Daily traction
                </h2>
                <p className="text-xs text-foreground/55 mt-0.5">
                  Upvotes, points, and reposts on posts published each day,
                  last {WINDOW_DAYS} days.
                </p>
              </div>
              <Legend color="var(--brand-green, #16a34a)" label="Traction" />
            </div>
            <TractionBars buckets={buckets} loading={loading} />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-6 flex flex-col gap-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="font-serif text-xl tracking-tight">
                  Comment velocity
                </h2>
                <p className="text-xs text-foreground/55 mt-0.5">
                  Comments on posts published each day, last {WINDOW_DAYS} days.
                </p>
              </div>
              <Legend color="var(--brand, #f97316)" label="Comments" />
            </div>
            <CommentLine buckets={buckets} loading={loading} />
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function FilterPill({
  active,
  onClick,
  label,
  color,
  icon,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  color?: string;
  icon?: React.ReactNode;
}) {
  // Active pill borrows the platform brand color for its border + tint
  // so the chart's filter context is impossible to miss. Inactive pills
  // stay neutral.
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition-colors"
      style={
        active
          ? {
              borderColor: color ?? "var(--brand)",
              background: `color-mix(in oklab, ${color ?? "var(--brand)"} 14%, transparent)`,
              color: "var(--foreground)",
            }
          : {
              borderColor: "color-mix(in oklab, var(--foreground) 14%, transparent)",
              color: "color-mix(in oklab, var(--foreground) 70%, transparent)",
            }
      }
    >
      {icon}
      {label}
    </button>
  );
}

function StatsStrip({
  totals,
}: {
  totals: { posts: number; traction: number; comments: number };
}) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
      <StatCard label="Posts watched" value={totals.posts.toLocaleString()} />
      <StatCard
        label="Total traction"
        value={totals.traction.toLocaleString()}
        accent="green"
      />
      <StatCard
        label="Total comments"
        value={totals.comments.toLocaleString()}
      />
    </div>
  );
}

function StatCard({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: "green";
}) {
  return (
    <Card>
      <CardContent className="p-5 flex flex-col gap-1">
        <span className="text-xs uppercase tracking-wider text-foreground/55">
          {label}
        </span>
        <span
          className="font-serif text-3xl tracking-tight"
          style={
            accent === "green" ? { color: "var(--brand-green, #16a34a)" } : undefined
          }
        >
          {value}
        </span>
      </CardContent>
    </Card>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <div className="flex items-center gap-2 text-xs text-foreground/65">
      <span
        className="inline-block size-2.5 rounded-sm"
        style={{ background: color }}
      />
      {label}
    </div>
  );
}

// Bar chart. SVG sized via viewBox so it scales fluidly with the card.
// Bars are green for the "traction = good" mental model the user
// asked for. Day labels under each bar; the highest bar gets its
// numeric value pinned above it so the chart has a readable anchor
// without a full y-axis.
function TractionBars({
  buckets,
  loading,
}: {
  buckets: DayBucket[];
  loading: boolean;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.traction));
  const peakIdx = buckets.findIndex((b) => b.traction === max);

  if (loading) {
    return <ChartSkeleton height={220} />;
  }

  return (
    <div className="w-full">
      <svg
        viewBox="0 0 700 240"
        preserveAspectRatio="none"
        className="w-full h-56"
        role="img"
        aria-label="Daily traction bar chart"
      >
        {/* Baseline so empty days still have a visual floor. */}
        <line
          x1={0}
          x2={700}
          y1={200}
          y2={200}
          stroke="currentColor"
          opacity={0.1}
        />
        {buckets.map((b, i) => {
          const slot = 700 / buckets.length;
          const barW = slot * 0.55;
          const x = i * slot + (slot - barW) / 2;
          const h = (b.traction / max) * 170;
          const y = 200 - h;
          const isPeak = i === peakIdx && b.traction > 0;
          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={h}
                rx={3}
                fill="var(--brand-green, #16a34a)"
                opacity={b.traction === 0 ? 0.15 : 0.9}
              />
              {isPeak && (
                <text
                  x={x + barW / 2}
                  y={y - 6}
                  textAnchor="middle"
                  fontSize="11"
                  fill="currentColor"
                  opacity={0.7}
                >
                  {b.traction}
                </text>
              )}
              <text
                x={x + barW / 2}
                y={222}
                textAnchor="middle"
                fontSize="10"
                fill="currentColor"
                opacity={0.55}
              >
                {b.date.toLocaleDateString(undefined, {
                  month: "numeric",
                  day: "numeric",
                })}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// Smooth-ish line chart for comments. Uses a single polyline plus a
// faint area fill under it for body. Same x positions as the bars so
// the two charts read as the same window.
function CommentLine({
  buckets,
  loading,
}: {
  buckets: DayBucket[];
  loading: boolean;
}) {
  const max = Math.max(1, ...buckets.map((b) => b.comments));

  if (loading) {
    return <ChartSkeleton height={180} />;
  }

  const slot = 700 / buckets.length;
  const points = buckets.map((b, i) => {
    const x = i * slot + slot / 2;
    const y = 160 - (b.comments / max) * 130;
    return { x, y, b };
  });

  const polyline = points.map((p) => `${p.x},${p.y}`).join(" ");
  const area =
    `${points[0].x},180 ` +
    polyline +
    ` ${points[points.length - 1].x},180`;

  return (
    <div className="w-full">
      <svg
        viewBox="0 0 700 200"
        preserveAspectRatio="none"
        className="w-full h-44"
        role="img"
        aria-label="Comment velocity line chart"
      >
        <line
          x1={0}
          x2={700}
          y1={180}
          y2={180}
          stroke="currentColor"
          opacity={0.1}
        />
        <polygon points={area} fill="var(--brand, #f97316)" opacity={0.12} />
        <polyline
          points={polyline}
          fill="none"
          stroke="var(--brand, #f97316)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
        />
        {points.map((p, i) => (
          <circle
            key={i}
            cx={p.x}
            cy={p.y}
            r={p.b.comments > 0 ? 3 : 1.5}
            fill="var(--brand, #f97316)"
            opacity={p.b.comments > 0 ? 1 : 0.3}
          />
        ))}
      </svg>
    </div>
  );
}

// Skeleton placeholder while posts load. Same heights as the real
// charts so the page doesn't shift when data arrives.
function ChartSkeleton({ height }: { height: number }) {
  return (
    <div
      className="w-full rounded-md animate-pulse"
      style={{
        height,
        background: "color-mix(in oklab, var(--foreground) 5%, transparent)",
      }}
    />
  );
}
