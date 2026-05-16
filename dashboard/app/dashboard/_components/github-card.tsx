"use client";

import { useEffect, useState } from "react";
import { FaGithub } from "react-icons/fa6";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  disconnectGithub,
  fetchGithubStatus,
  saveGithubPat,
  type GithubStatus,
} from "@/lib/agent";

// GithubCard, the settings-page UI for managing the stored personal
// access token. Two resting states:
//
//   not_connected: a PAT input + Save button so the user can paste a
//                  token without going through onboarding again.
//   connected:     a green pill with @login plus a Disconnect link.
//
// The link out to github.com/settings/applications is shown when
// connected so the user can fully revoke (we only forget the token
// locally on disconnect).
export function GithubCard() {
  const [status, setStatus] = useState<GithubStatus | null>(null);
  const [pat, setPat] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyDisconnect, setBusyDisconnect] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchGithubStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    const fresh = await fetchGithubStatus();
    setStatus(fresh);
  }

  async function handleSave() {
    setError(null);
    setSaving(true);
    const result = await saveGithubPat(pat.trim());
    setSaving(false);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setPat("");
    await refresh();
  }

  async function handleDisconnect() {
    setBusyDisconnect(true);
    const ok = await disconnectGithub();
    if (ok) await refresh();
    setBusyDisconnect(false);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <FaGithub aria-hidden />
          GitHub
        </CardTitle>
        <CardDescription>
          Paste a personal access token so Pincer can fetch your repo
          READMEs. Required for any GitHub-backed feature.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {status === null && (
          <p className="text-sm text-foreground/55">Checking connection...</p>
        )}

        {status !== null && !status.connected && (
          <div className="flex flex-col gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-sm font-medium">Personal access token</span>
              <input
                type="password"
                value={pat}
                onChange={(e) => setPat(e.target.value)}
                placeholder="github_pat_..."
                disabled={saving}
                className="rounded-lg border border-foreground/15 bg-background px-3 py-2 font-mono text-sm focus:outline-none focus:border-foreground/40 disabled:opacity-60"
              />
              <span className="text-xs text-foreground/55 leading-relaxed">
                Create one at{" "}
                <a
                  href="https://github.com/settings/tokens?type=beta"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-foreground"
                >
                  github.com/settings/tokens
                </a>
                . For private repos pick the{" "}
                <span className="font-mono">Contents: Read</span>{" "}
                permission; for public-only a token with no scopes is
                enough.
              </span>
            </label>

            <div className="flex items-center justify-between gap-3">
              {error && (
                <p className="text-xs text-red-700 dark:text-red-400 font-mono">
                  {error}
                </p>
              )}
              <Button
                onClick={handleSave}
                disabled={saving || pat.trim().length < 10}
                className="ml-auto"
              >
                {saving ? "Saving..." : "Save token"}
              </Button>
            </div>
          </div>
        )}

        {status !== null && status.connected && (
          <div className="flex flex-col gap-3">
            <div className="rounded-lg border border-green-500/40 bg-green-500/5 px-3 py-2 flex items-center justify-between gap-3">
              <span className="text-sm text-foreground/85">
                Connected as{" "}
                <span className="font-mono">@{status.login ?? "github"}</span>
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={handleDisconnect}
                disabled={busyDisconnect}
              >
                {busyDisconnect ? "Disconnecting..." : "Disconnect"}
              </Button>
            </div>
            <p className="text-xs text-foreground/55 leading-relaxed">
              Disconnect forgets the token locally. To fully revoke the
              token on GitHub&apos;s side, delete it from{" "}
              <a
                href="https://github.com/settings/tokens"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                github.com/settings/tokens
              </a>
              .
            </p>
          </div>
        )}

        {status !== null && !status.agent_reachable && (
          <p className="text-xs text-red-700 dark:text-red-400 leading-relaxed">
            Could not reach the agent. Connection state may be out of date.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
