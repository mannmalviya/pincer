import Link from "next/link";
import { FaGithub } from "react-icons/fa6";

import { PincerMark } from "@/components/site/pincer-mark";
import { FeaturesShowcase } from "@/components/site/features-showcase";
import { PlatformBeams } from "@/components/site/platform-beams";
import { PlatformMarquee } from "@/components/site/platform-marquee";

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

        {/* YC-inspired serif subhead. Italic accents the payoff phrase so
            the eye lands on the value, not the mechanism. */}
        <p className="font-serif text-2xl sm:text-3xl text-foreground/80 mt-8 max-w-2xl leading-snug">
          Pincer raises the signal-to-noise ratio, so you can focus on
          what truly matters: <em>building your product</em>.
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

      {/* Trust-bar marquee — sits right under the hero (conventional
          landing-page rhythm) and reinforces the "we post everywhere you
          live" claim before the user reads any feature copy. */}
      <PlatformMarquee />

      {/* What Pincer does — animated client island; section chrome
          (border-t, padding, centered heading) lives inside the component
          to keep the landing page's vertical rhythm consistent. */}
      <FeaturesShowcase />

      {/* How it works */}
      <section className="border-t border-foreground/10 px-6 py-20">
        <div className="max-w-5xl mx-auto">
          <h2 className="font-serif text-3xl sm:text-4xl tracking-tight text-center mb-12">
            How it works
          </h2>

          {/* Simple beam diagram. Solid wires with a slow opacity
              pulse, no traveling dashes or stacked drop-shadow filters,
              so the section stays smooth. */}
          <PlatformBeams />

          <ol className="grid gap-8 sm:grid-cols-3 mt-16">
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
          <div className="flex items-center gap-4">
            <span>Built on NVIDIA Nemotron 3 via NIM</span>
            {/* Small GitHub badge. Pill keeps it readable as a link
                target without competing with the footer's muted tone. */}
            <a
              href="https://github.com/mannmalviya/pincer"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-full border border-foreground/15 px-2.5 py-1 hover:bg-foreground/5 hover:text-foreground transition-colors"
            >
              <FaGithub className="text-sm" />
              <span>GitHub</span>
            </a>
          </div>
        </div>
      </footer>
    </main>
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

