import Link from "next/link";

import { PincerMark } from "@/components/site/pincer-mark";

// ---------------------------------------------------------------------------
// Landing page — Pincer marketing surface.
//
// Pincer is a clone-and-run-local app (single user), so this isn't a sales
// page in the classic sense; it's the front door of the local app. The
// structure mirrors career-gap (hero → features → steps → final CTA) so the
// editorial feel carries across both projects.
//
// CTAs point inward:
//   • Get started → /onboarding   (first-run wizard for Reddit/Discord creds)
//   • Open dashboard → /dashboard (returning users)
// ---------------------------------------------------------------------------
export default function Landing() {
  return (
    <main className="font-sans">
      {/* Hero */}
      <section className="min-h-[70vh] flex flex-col items-center justify-center px-6 py-20 text-center">
        <PincerMark className="w-12 h-12 mb-8" />

        <h1 className="font-serif text-5xl sm:text-7xl tracking-tight max-w-3xl leading-[1.05]">
          Get a grip on your launch.
        </h1>

        <p className="text-lg sm:text-xl text-foreground/70 mt-6 max-w-xl leading-relaxed">
          Pincer drafts platform-tailored posts, ships them to Reddit and
          Discord, and triages every comment — so launch day stops eating
          your week.
        </p>

        <div className="flex gap-3 mt-10">
          <Link
            href="/onboarding"
            className="shine rounded-full bg-foreground text-background px-6 h-12 flex items-center font-medium hover:opacity-90"
          >
            Get started →
          </Link>
          <Link
            href="/dashboard"
            className="rounded-full border border-foreground/15 px-6 h-12 flex items-center font-medium hover:bg-foreground/5"
          >
            Open dashboard
          </Link>
        </div>
      </section>

      {/* What you get */}
      <section className="border-t border-foreground/10 px-6 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-sans text-sm uppercase tracking-wider text-foreground/50 text-center mb-12">
            What you get
          </h2>

          <div className="grid gap-10 sm:grid-cols-3">
            <Feature
              title="Tailored drafts"
              body="One product brief in, three platform-aware drafts out. Reddit gets problem-first; Discord gets casual; HN gets a blunt title."
            />
            <Feature
              title="Comment triage"
              body="The agent polls every 60 seconds, classifies new comments, and routes the hard ones to your inbox with a suggested reply already drafted."
            />
            <Feature
              title="Live analytics"
              body="Upvotes, views, and comment velocity per platform — all in one chart, all from a single SQLite file you own."
            />
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="border-t border-foreground/10 px-6 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-sans text-sm uppercase tracking-wider text-foreground/50 text-center mb-12">
            How it works
          </h2>

          <ol className="grid gap-8 sm:grid-cols-3">
            <Step n={1} title="Connect your accounts">
              Paste your Reddit script-app credentials and a Discord bot
              token. Pincer keeps them in a local SQLite file — nothing
              leaves your machine.
            </Step>
            <Step n={2} title="Draft and approve">
              Drop a 3-line product brief into the compose pane. Edit each
              platform draft side-by-side, then ship them with one click.
            </Step>
            <Step n={3} title="Triage from the inbox">
              FAQ-style comments are handled silently. The hard ones land
              in your inbox with a Nemotron-drafted reply, ready to edit
              and send.
            </Step>
          </ol>
        </div>
      </section>

      {/* Final CTA */}
      <section className="border-t border-foreground/10 px-6 py-20 text-center">
        <h2 className="font-serif text-3xl sm:text-4xl tracking-tight">
          Ready to ship your launch?
        </h2>
        <p className="text-foreground/70 mt-3">
          Onboarding takes about two minutes.
        </p>
        <div className="flex gap-3 justify-center mt-8">
          <Link
            href="/onboarding"
            className="shine rounded-full bg-foreground text-background px-6 h-12 flex items-center font-medium hover:opacity-90"
          >
            Get started →
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-foreground/10 px-6 py-8">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-3 text-xs text-foreground/50">
          <span className="font-mono">pincer · v0</span>
          <span>Built on OpenClaw + NVIDIA Nemotron 3</span>
        </div>
      </footer>
    </main>
  );
}

// Small presentational helpers — kept inline so the file stays self-contained.
function Feature({ title, body }: { title: string; body: string }) {
  return (
    <div className="flex flex-col gap-2">
      <h3 className="font-semibold tracking-tight">{title}</h3>
      <p className="text-sm text-foreground/65 leading-relaxed">{body}</p>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li className="flex flex-col gap-2">
      <span className="text-xs font-mono text-foreground/40">
        {String(n).padStart(2, "0")}
      </span>
      <h3 className="font-semibold tracking-tight">{title}</h3>
      <p className="text-sm text-foreground/65 leading-relaxed">{children}</p>
    </li>
  );
}

