import { BackfillCard } from "../_components/backfill-card";

// /dashboard/settings — single page for everything that's not part of the
// main daily loop. Right now that's just the backfill form; future tenants
// for this page: per-platform watch toggles, agent base URL override,
// notification preferences.
export default function SettingsPage() {
  return (
    <div className="flex flex-col gap-12">
      <section>
        <p className="text-xs font-mono text-foreground/40 uppercase tracking-wider">
          Settings
        </p>
        <h1 className="font-serif text-4xl sm:text-5xl tracking-tight leading-[1.05] mt-2">
          Tune Pincer.
        </h1>
        <p className="text-foreground/70 mt-3 max-w-xl leading-relaxed">
          Add old posts to the watch list or wire up new platforms.
        </p>
      </section>

      <section>
        <BackfillCard />
      </section>
    </div>
  );
}
