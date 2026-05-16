import { BackfillCard } from "../_components/backfill-card";
import { DangerZoneCard } from "../_components/danger-zone-card";
import { GithubCard } from "../_components/github-card";
import { PollSettingsCard } from "../_components/poll-settings-card";

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
        <GithubCard />
      </section>

      <section>
        <PollSettingsCard />
      </section>

      <section>
        <BackfillCard />
      </section>

      <section>
        <DangerZoneCard />
      </section>
    </div>
  );
}
