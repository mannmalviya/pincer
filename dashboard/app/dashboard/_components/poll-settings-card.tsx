"use client";

import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { fetchSettings, patchSettings, type AgentSettings } from "@/lib/agent";

// PollSettingsCard, the agent's runtime polling configuration.
//
//   - Base interval: how often the scheduler ticks (seconds). Floor 30s,
//     ceiling 1h, enforced by the agent.
//   - Adaptive polling: when on, older posts are stretched. The schedule
//     uses these multipliers:
//        < 1 hour  → 1x
//        < 24 hours → 2x
//        < 7 days   → 10x
//        < 30 days  → 60x
//        >= 30 days → 360x
const MIN_INTERVAL = 30;
const MAX_INTERVAL = 3600;

export function PollSettingsCard() {
  const [settings, setSettings] = useState<AgentSettings | null>(null);
  const [loaded, setLoaded] = useState(false);

  // Local edit state. Initialized from `settings` and kept in lockstep
  // until the user submits, at which point we PATCH and refresh.
  const [intervalDraft, setIntervalDraft] = useState("");
  const [adaptiveDraft, setAdaptiveDraft] = useState(true);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const s = await fetchSettings();
      if (cancelled) return;
      setSettings(s);
      if (s) {
        setIntervalDraft(String(s.base_poll_interval_seconds));
        setAdaptiveDraft(s.adaptive_polling_enabled);
      }
      setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const intervalNumber = Number(intervalDraft);
  const intervalValid =
    Number.isFinite(intervalNumber) &&
    intervalNumber >= MIN_INTERVAL &&
    intervalNumber <= MAX_INTERVAL;

  const dirty =
    settings !== null &&
    (intervalNumber !== settings.base_poll_interval_seconds ||
      adaptiveDraft !== settings.adaptive_polling_enabled);

  async function handleSave() {
    if (!intervalValid) return;
    setSaving(true);
    setError(null);
    setSaved(false);
    const next = await patchSettings({
      base_poll_interval_seconds: intervalNumber,
      adaptive_polling_enabled: adaptiveDraft,
    });
    if (next === null) {
      setError("Could not save. Is the agent reachable?");
    } else {
      setSettings(next);
      setIntervalDraft(String(next.base_poll_interval_seconds));
      setAdaptiveDraft(next.adaptive_polling_enabled);
      setSaved(true);
    }
    setSaving(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-xl tracking-tight">
          Polling
        </CardTitle>
        <CardDescription>
          How often Pincer checks each watched post for new comments and
          score updates.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {!loaded && (
          <p className="text-sm text-foreground/55">Loading...</p>
        )}

        {loaded && settings === null && (
          <p className="text-sm text-red-700 dark:text-red-400">
            Agent unreachable. Cannot load polling settings.
          </p>
        )}

        {loaded && settings !== null && (
          <>
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">
                Base interval (seconds)
              </span>
              <input
                type="number"
                min={MIN_INTERVAL}
                max={MAX_INTERVAL}
                step={10}
                value={intervalDraft}
                onChange={(e) => {
                  setIntervalDraft(e.target.value);
                  setSaved(false);
                }}
                disabled={saving}
                className="w-40 rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:border-foreground/40 disabled:opacity-60"
              />
              <span className="text-xs text-foreground/55">
                Between {MIN_INTERVAL}s and {MAX_INTERVAL}s. Lower values
                poll faster but use more rate-limit budget.
              </span>
              {!intervalValid && intervalDraft.length > 0 && (
                <span className="text-xs text-red-700 dark:text-red-400">
                  Pick a whole number between {MIN_INTERVAL} and{" "}
                  {MAX_INTERVAL}.
                </span>
              )}
            </label>

            <label
              htmlFor="adaptive-polling"
              className="flex items-start gap-3 rounded-lg border border-foreground/10 bg-foreground/[0.02] px-3 py-2 cursor-pointer"
            >
              <Checkbox
                id="adaptive-polling"
                checked={adaptiveDraft}
                onCheckedChange={(v) => {
                  setAdaptiveDraft(v === true);
                  setSaved(false);
                }}
              />
              <div className="flex flex-col gap-1">
                <span className="text-sm font-medium">
                  Slow down for older posts
                </span>
                <span className="text-xs text-foreground/55 leading-relaxed">
                  Posts under 1h poll at the base interval. 1-24h: 2x. 1-7d:
                  10x. 7-30d: 60x. 30+ days: 360x. Saves bandwidth on aged
                  posts whose score has settled.
                </span>
              </div>
            </label>

            <div className="flex items-center justify-between gap-3">
              {error && (
                <span className="text-xs text-red-700 dark:text-red-400">
                  {error}
                </span>
              )}
              {saved && !error && (
                <span className="text-xs text-foreground/55">Saved.</span>
              )}
              <Button
                onClick={handleSave}
                disabled={!dirty || !intervalValid || saving}
                className="ml-auto"
              >
                {saving ? "Saving..." : "Save"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
