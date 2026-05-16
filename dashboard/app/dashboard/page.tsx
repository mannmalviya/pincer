import Link from "next/link";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

// ---------------------------------------------------------------------------
// /dashboard — Overview.
//
// First thing users see after onboarding. Shows the headline counters
// (posts, pending escalations, comments tracked) and three jump-off cards
// to Compose / Inbox / Analytics.
//
// Numbers here are zero-state placeholders. Once the agent + SQLite are
// wired up these will pull live counts via a small server query in
// `lib/db.ts`.
// ---------------------------------------------------------------------------
export default function DashboardOverview() {
  return (
    <div className="flex flex-col gap-12">
      {/* Hero / status */}
      <section>
        <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
          Overview
        </p>
        <h1 className="font-serif text-4xl sm:text-5xl tracking-tight leading-[1.05] mt-2">
          Pincer is standing by.
        </h1>
        <p className="text-foreground/70 mt-3 max-w-xl leading-relaxed">
          No launches yet. Drop a product brief into Compose to draft your
          first batch of posts.
        </p>
      </section>

      {/* Top-line metrics */}
      <section className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Stat label="Posts live" value="0" />
        <Stat label="Pending replies" value="0" />
        <Stat label="Comments tracked" value="0" />
      </section>

      {/* Jump-off cards */}
      <section>
        <h2 className="text-sm uppercase tracking-wider text-foreground/50 mb-4">
          Jump in
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <JumpCard
            href="/dashboard/compose"
            title="Compose"
            body="Turn a 3-line brief into platform-tailored drafts and ship them in one click."
          />
          <JumpCard
            href="/dashboard/inbox"
            title="Inbox"
            body="Triage comments the agent couldn't handle on its own. Suggested reply included."
          />
          <JumpCard
            href="/dashboard/analytics"
            title="Analytics"
            body="Upvotes, views, and comment velocity across every platform you've posted on."
          />
        </div>
      </section>
    </div>
  );
}

// Stat — one big number + caption. Mono number gives it a console-y feel.
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

// JumpCard — a clickable card that links to one of the four subsections.
function JumpCard({
  href,
  title,
  body,
}: {
  href: string;
  title: string;
  body: string;
}) {
  return (
    <Link href={href} className="block group">
      <Card className="h-full transition-colors group-hover:border-foreground/30">
        <CardHeader>
          <CardTitle className="font-serif text-xl tracking-tight">
            {title}
          </CardTitle>
          <CardDescription>{body}</CardDescription>
        </CardHeader>
      </Card>
    </Link>
  );
}
