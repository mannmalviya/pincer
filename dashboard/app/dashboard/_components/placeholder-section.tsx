// PlaceholderSection — shared empty-state block for the dashboard sub-routes
// that exist only as scaffolding right now (Compose, Inbox, Analytics).
//
// Lives under `_components/` (underscore prefix means Next.js won't treat
// it as a routable segment) so it's co-located with the dashboard tree
// without leaking into the URL space.

export function PlaceholderSection({
  label,
  title,
  body,
}: {
  label: string;
  title: string;
  body: string;
}) {
  return (
    <section className="max-w-2xl">
      <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
        {label}
      </p>
      <h1 className="font-serif text-4xl sm:text-5xl tracking-tight leading-[1.05] mt-2">
        {title}
      </h1>
      <p className="text-foreground/70 mt-4 leading-relaxed">{body}</p>

      <div className="mt-8 rounded-xl border border-dashed border-foreground/15 p-8 text-center">
        <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
          Coming soon
        </p>
        <p className="text-sm text-foreground/60 mt-2">
          UI lands once the agent side is wired up.
        </p>
      </div>
    </section>
  );
}
