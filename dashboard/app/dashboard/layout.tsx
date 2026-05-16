import Link from "next/link";

import { PincerMark } from "@/components/site/pincer-mark";

// ---------------------------------------------------------------------------
// Dashboard layout — wraps every /dashboard/* route.
//
// Single-user local app, so there's no auth, no user menu, no team switcher.
// Just a thin top nav with the brand mark + the four primary sections from
// PLAN.md (Overview / Compose / Inbox / Analytics).
//
// Kept as a server component — no interactivity lives here. Sub-pages are
// server components too unless they need client state.
// ---------------------------------------------------------------------------
export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="font-sans flex-1 flex flex-col">
      <header className="px-6 py-4 border-b border-foreground/10 sticky top-0 bg-background/95 backdrop-blur z-10">
        <div className="max-w-6xl mx-auto flex items-center justify-between gap-6">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-sm hover:opacity-80"
          >
            <PincerMark className="w-6 h-6" />
            <span className="font-medium">Pincer</span>
          </Link>

          <nav className="flex items-center gap-1 text-sm">
            <NavLink href="/dashboard">Overview</NavLink>
            <NavLink href="/dashboard/compose">Compose</NavLink>
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

// NavLink — minimal pill-shaped link. Active state would normally use
// usePathname, but that needs a client component. We can swap to a small
// client wrapper later if/when active highlighting becomes useful.
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
      className="px-3 h-8 flex items-center rounded-full text-foreground/70 hover:text-foreground hover:bg-foreground/5 transition-colors"
    >
      {children}
    </Link>
  );
}
