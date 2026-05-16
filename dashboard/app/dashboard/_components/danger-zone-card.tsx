"use client";

// DangerZoneCard. The /dashboard/settings "burn it all down" surface.
//
// Modelled on GitHub's repo-delete UI:
//   1. The card is visually marked as dangerous (red border, red heading,
//      muted-red background) so it never blends in with the normal cards.
//   2. The destructive button is gated by a typed confirmation: the user
//      has to literally type the exact phrase the agent expects. Clicking
//      around can't trigger it; muscle memory can't either.
//   3. The agent re-checks the same phrase server-side, so a misconfigured
//      client cannot bypass the gate.
//
// Right now there is one action: wipe the agent's SQLite database. This
// is mainly a testing convenience between demo runs, but the same pattern
// is what we'd reuse for any other irreversible action we add later
// (forget all PATs, disconnect every platform, etc).

import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resetAgentDb } from "@/lib/agent";

// The phrase the user has to type, and the same phrase the agent checks
// server-side. Keep these in sync with agent/src/routes/admin.ts.
const CONFIRMATION_PHRASE = "DELETE EVERYTHING";

export function DangerZoneCard() {
  // Typed confirmation phrase. The reset button only enables when this
  // matches CONFIRMATION_PHRASE exactly (case-sensitive, no trimming).
  const [phrase, setPhrase] = useState("");

  // UI state machine. We don't need a full state library here, four
  // booleans cover every visual outcome: idle, in-flight, success, error.
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const phraseMatches = phrase === CONFIRMATION_PHRASE;

  async function handleReset() {
    if (!phraseMatches) return;
    setSubmitting(true);
    setError(null);
    setDone(false);
    const result = await resetAgentDb(CONFIRMATION_PHRASE);
    if (result.ok) {
      setDone(true);
      setPhrase("");
    } else {
      setError(result.message);
    }
    setSubmitting(false);
  }

  return (
    // Red ring + soft red wash so the card reads as a hazard zone at a
    // glance. Dark-mode variants keep the same intent without becoming
    // illegibly bright.
    <Card className="border-red-500/50 bg-red-50/40 dark:bg-red-950/10">
      <CardHeader>
        <CardTitle className="font-serif text-xl tracking-tight text-red-700 dark:text-red-400">
          Danger zone
        </CardTitle>
        <CardDescription className="text-red-700/80 dark:text-red-400/80">
          Irreversible actions. Read carefully before clicking.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-5">
        {/* Action row. The label on the left, the gated control on the
            right. Same shape we can reuse for future danger actions. */}
        <div className="flex flex-col gap-2 rounded-lg border border-red-500/40 bg-background/60 p-4">
          <div className="flex flex-col gap-1">
            <span className="text-sm font-semibold text-red-700 dark:text-red-400">
              Clear the agent database
            </span>
            <span className="text-xs text-foreground/70 leading-relaxed">
              Deletes every watched post, every comment, every snapshot,
              the onboarding answers, and the stored GitHub PAT. Useful
              for testing a clean install. This cannot be undone.
            </span>
          </div>

          <label className="flex flex-col gap-1 mt-2">
            <span className="text-xs text-foreground/70">
              Type{" "}
              <span className="font-mono font-semibold">
                {CONFIRMATION_PHRASE}
              </span>{" "}
              to confirm:
            </span>
            <input
              type="text"
              value={phrase}
              onChange={(e) => {
                setPhrase(e.target.value);
                setDone(false);
                setError(null);
              }}
              disabled={submitting}
              autoComplete="off"
              spellCheck={false}
              className="w-full rounded-lg border border-red-500/40 bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:border-red-500 disabled:opacity-60"
            />
          </label>

          <div className="flex items-center justify-between gap-3 mt-1">
            {/* Status / error line. Sits to the left of the button so the
                user does not have to look elsewhere to see the outcome. */}
            <div className="text-xs">
              {error && (
                <span className="text-red-700 dark:text-red-400">{error}</span>
              )}
              {done && !error && (
                <span className="text-foreground/70">
                  Database cleared. Reload the dashboard to start fresh.
                </span>
              )}
            </div>

            <Button
              type="button"
              onClick={handleReset}
              disabled={!phraseMatches || submitting}
              className="ml-auto bg-red-600 hover:bg-red-700 text-white disabled:bg-red-600/40 disabled:text-white/80"
            >
              {submitting ? "Clearing..." : "Clear database"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
