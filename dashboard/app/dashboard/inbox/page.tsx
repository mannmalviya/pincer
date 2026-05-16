// /dashboard/inbox — recent-posts shelf.
//
// Used to be a placeholder for the "needs human review" inbox. The
// classification + escalation pipeline isn't wired up yet, and in the
// meantime the page was dead weight. Repurposed as a recency-ordered
// shelf of every post Pincer is tracking, where clicking a card opens
// the post on its source platform in a new tab.
//
// Why a separate page rather than a section on the main dashboard:
// the main /dashboard view leads with charts + the comments feed.
// Users who want to jump back to one of their actual posts shouldn't
// have to scroll past those — a flat, dedicated list is the fastest
// route there.

import { PostsShelf } from "../_components/posts-shelf";

export default function InboxPage() {
  return (
    <div className="flex flex-col gap-8">
      <section>
        <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
          Posts
        </p>
        <h1 className="font-serif text-4xl sm:text-5xl tracking-tight leading-[1.05] mt-2">
          Jump back to a post.
        </h1>
        <p className="text-foreground/70 mt-3 max-w-xl leading-relaxed">
          Everything Pincer is tracking, newest first. Click a card to
          open it on the platform where you posted.
        </p>
      </section>

      <PostsShelf />
    </div>
  );
}
