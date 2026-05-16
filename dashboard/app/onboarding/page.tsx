import Link from "next/link";

import { PincerMark } from "@/components/site/pincer-mark";

import { OnboardingWizard } from "./onboarding-wizard";

// ---------------------------------------------------------------------------
// /onboarding — first-run setup for Pincer.
//
// Users land here from the homepage's "Get started →" CTA. They paste the
// credentials Pincer needs to post on their behalf (Reddit script-app +
// Discord bot). Everything is stored locally in the SQLite file the agent
// process and the dashboard share — nothing leaves the machine.
//
// This page is a server component for the layout and copy. The form itself
// is a client component (state, validation, navigation) imported below.
// ---------------------------------------------------------------------------
export default function OnboardingPage() {
  return (
    <main className="font-sans flex-1 flex flex-col">
      {/* Top bar — back to landing.
          Flex row spans the full padded width (no max-w wrapper) so the
          brand sits flush-left and the SETUP label sits flush-right against
          the viewport edges, only inset by the header's own `px-6`. */}
      <header className="px-6 py-5 border-b border-foreground/10 flex items-center justify-between">
        <Link
          href="/"
          className="flex items-center gap-3 text-lg text-foreground/70 hover:text-foreground"
        >
          <PincerMark className="w-10 h-10" />
          <span className="font-medium">Pincer</span>
        </Link>
        <span className="font-mono text-sm text-foreground/40 uppercase tracking-wider">
          Setup
        </span>
      </header>

      <section className="flex-1 px-6 pt-8 pb-16">
        <div className="max-w-2xl mx-auto">
          {/* Heading */}
          <div className="text-center mb-12">
            <h1 className="font-serif text-4xl sm:text-5xl tracking-tight leading-[1.05]">
              Let&apos;s get you set up.
            </h1>
            <p className="text-foreground/70 mt-4 max-w-md mx-auto leading-relaxed">
              Pincer needs read/write access to the platforms it will post on.
              Credentials are saved locally to <span className="font-mono text-foreground/80">./data.db</span>.
            </p>
          </div>

          {/* The wizard itself */}
          <OnboardingWizard />
        </div>
      </section>
    </main>
  );
}
