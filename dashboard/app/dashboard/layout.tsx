import Link from "next/link";

import { PincerMark } from "@/components/site/pincer-mark";

// ---------------------------------------------------------------------------
// Dashboard layout, wraps every /dashboard/* route.
//
// Single-user local app, so there's no auth, no user menu, no team switcher.
// Just a thin top nav with the brand mark + the four primary sections from
// PLAN.md (Overview / New Post / Inbox / Analytics).
//
// Header sizing matches /onboarding so the user doesn't experience a layout
// shift between setup and the main app: py-5 vertical, w-10 brand mark,
// text-lg brand wordmark.
//
// Kept as a server component, no interactivity lives here. Sub-pages are
// server components too unless they need client state.
// ---------------------------------------------------------------------------
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="font-sans flex-1 flex flex-col">
      <header className="px-6 py-5 border-b border-foreground/10 sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-6">
          <Link
            href="/dashboard"
            className="flex items-center gap-3 text-lg text-foreground/85 hover:text-foreground"
          >
            <PincerMark className="w-10 h-10" />
            <span className="font-medium">Pincer</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            <NavLink href="/dashboard">Overview</NavLink>
            <NavLink href="/dashboard/newpost">New Post</NavLink>
            <NavLink href="/dashboard/inbox">Inbox</NavLink>
            <NavLink href="/dashboard/analytics">Analytics</NavLink>
          </nav>
        </div>
      </header>

      <main className="flex-1 px-6 py-10">
        <div className="max-w-6xl mx-auto">{children}</div>
      </main>
    </div>
  );
}

function NavLink({
  href,
  children,
}: {
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="px-4 h-10 flex items-center text-base rounded-full text-foreground/85 hover:text-foreground hover:bg-foreground/5 transition-colors"
    >
      {children}
    </Link>
  );
}
