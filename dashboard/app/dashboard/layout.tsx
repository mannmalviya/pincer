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
  // Placeholder for the "user hasn't published anything yet" state. Drives
  // the New Post nav link's brand-tinted glow treatment, matching the JumpCard
  // on the overview page. When the agent + DB are wired up, swap this for an
  // actual count query (and unify with the same flag in /dashboard/page.tsx).
  const hasFirstPost = false;

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
            <NavLink href="/dashboard/newpost" primary={!hasFirstPost}>
              New Post
            </NavLink>
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

// NavLink, header navigation link.
//
// Default treatment is a minimal pill that fades in foreground/hover bg.
// `primary={true}` switches to a rectangular outlined box with a soft
// shiny-gold border + glow, used to nudge the user toward "New Post" while
// they still haven't shipped their first launch.
//
// Color references (kept verbatim so a designer can edit them in one place):
//   #d4af37  old-gold, the border line color
//   #fff8dc  cornsilk, the very-faint warm tint behind the text
//   rgba(255, 215, 0, ...)  pure gold (#FFD700) for the outer glow
//
// Active state would normally use usePathname, but that needs a client
// component. We can swap to a small client wrapper later if/when active
// highlighting becomes useful.
function NavLink({
  href,
  children,
  primary = false,
}: {
  href: string;
  children: React.ReactNode;
  primary?: boolean;
}) {
  const primaryClasses =
    "rounded-md border border-[#d4af37] bg-[#fff8dc]/40 " +
    "shadow-[0_0_14px_0_rgba(255,215,0,0.55)] " +
    "hover:bg-[#fff8dc]/60 " +
    "hover:shadow-[0_0_22px_2px_rgba(255,215,0,0.75)] " +
    "text-foreground";

  return (
    <Link
      href={href}
      className={
        "px-4 h-10 flex items-center text-base transition-all " +
        (primary
          ? primaryClasses
          : "rounded-full text-foreground/85 hover:text-foreground hover:bg-foreground/5")
      }
    >
      {children}
    </Link>
  );
}
