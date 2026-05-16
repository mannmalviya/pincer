"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

// ---------------------------------------------------------------------------
// OnboardingWizard — a 2-step credential setup flow.
//
// Step 1 — Reddit script-app: clientId, clientSecret, username, password,
//          userAgent. Reddit's API expects all five for password-grant auth,
//          which is what snoowrap uses under the hood.
//
// Step 2 — Discord bot: token + channel ID (where Pincer will post).
//
// Submission is stubbed: we POST to /api/accounts (not implemented yet — the
// agent side of the project will wire that up), then route to /dashboard.
// For now if the endpoint is missing we just route through; this lets the
// UI be shipped and validated before the backend lands.
//
// ---------------------------------------------------------------------------

// Shape of everything the wizard collects across both steps.
type WizardState = {
  reddit: {
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    userAgent: string;
  };
  discord: {
    botToken: string;
    channelId: string;
  };
};

const INITIAL_STATE: WizardState = {
  reddit: {
    clientId: "",
    clientSecret: "",
    username: "",
    password: "",
    userAgent: "pincer/0.1 (by /u/yourname)",
  },
  discord: {
    botToken: "",
    channelId: "",
  },
};

export function OnboardingWizard() {
  const router = useRouter();

  // Which step is the user on (1 = Reddit, 2 = Discord). Step state is
  // intentionally local — there's no need to persist mid-wizard.
  const [step, setStep] = useState<1 | 2>(1);
  const [state, setState] = useState<WizardState>(INITIAL_STATE);
  const [submitting, setSubmitting] = useState(false);

  // Cheap validation: each step requires its fields to be non-empty.
  // Reddit needs all five; Discord needs token + channel id.
  const redditValid =
    state.reddit.clientId.trim() &&
    state.reddit.clientSecret.trim() &&
    state.reddit.username.trim() &&
    state.reddit.password.trim() &&
    state.reddit.userAgent.trim();

  const discordValid =
    state.discord.botToken.trim() && state.discord.channelId.trim();

  // POST collected credentials to the API. The backend route doesn't exist
  // yet — we swallow that error and proceed so the UI can be developed
  // independently of the agent.
  async function handleFinish() {
    setSubmitting(true);
    try {
      await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
      }).catch(() => {
        // Endpoint is not implemented yet; ignore for now so the UI works.
      });
      router.push("/dashboard");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {/* Step indicator */}
      <StepIndicator step={step} />

      {step === 1 && (
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-2xl tracking-tight">
              Reddit
            </CardTitle>
            <CardDescription>
              Create a <span className="font-mono">script</span>-type app at{" "}
              <a
                href="https://www.reddit.com/prefs/apps"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 hover:text-foreground"
              >
                reddit.com/prefs/apps
              </a>
              . Brand new accounts get auto-flagged by popular subreddits —
              test against <span className="font-mono">r/test</span> or a sub
              you moderate.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field
              id="reddit-client-id"
              label="Client ID"
              value={state.reddit.clientId}
              onChange={(v) =>
                setState((s) => ({ ...s, reddit: { ...s.reddit, clientId: v } }))
              }
              placeholder="abc123..."
              mono
            />
            <Field
              id="reddit-client-secret"
              label="Client secret"
              type="password"
              value={state.reddit.clientSecret}
              onChange={(v) =>
                setState((s) => ({
                  ...s,
                  reddit: { ...s.reddit, clientSecret: v },
                }))
              }
              placeholder="••••••••••••"
              mono
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Field
                id="reddit-username"
                label="Username"
                value={state.reddit.username}
                onChange={(v) =>
                  setState((s) => ({
                    ...s,
                    reddit: { ...s.reddit, username: v },
                  }))
                }
                placeholder="your_bot_account"
              />
              <Field
                id="reddit-password"
                label="Password"
                type="password"
                value={state.reddit.password}
                onChange={(v) =>
                  setState((s) => ({
                    ...s,
                    reddit: { ...s.reddit, password: v },
                  }))
                }
                placeholder="••••••••"
              />
            </div>
            <Field
              id="reddit-user-agent"
              label="User agent"
              value={state.reddit.userAgent}
              onChange={(v) =>
                setState((s) => ({
                  ...s,
                  reddit: { ...s.reddit, userAgent: v },
                }))
              }
              placeholder="pincer/0.1 (by /u/yourname)"
              mono
              hint="Reddit requires a unique user-agent string per app."
            />

            <Separator className="my-2" />

            <div className="flex justify-between">
              <Link href="/" className={buttonVariants({ variant: "ghost" })}>
                Cancel
              </Link>
              <Button onClick={() => setStep(2)} disabled={!redditValid}>
                Next — Discord →
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {step === 2 && (
        <Card>
          <CardHeader>
            <CardTitle className="font-serif text-2xl tracking-tight">
              Discord
            </CardTitle>
            <CardDescription>
              Create a bot at{" "}
              <a
                href="https://discord.com/developers/applications"
                target="_blank"
                rel="noopener noreferrer"
                className="underline underline-offset-4 hover:text-foreground"
              >
                discord.com/developers
              </a>
              , invite it to your server, then paste its token and the
              channel ID Pincer should post to.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <Field
              id="discord-bot-token"
              label="Bot token"
              type="password"
              value={state.discord.botToken}
              onChange={(v) =>
                setState((s) => ({
                  ...s,
                  discord: { ...s.discord, botToken: v },
                }))
              }
              placeholder="MTE••••••••"
              mono
            />
            <Field
              id="discord-channel-id"
              label="Channel ID"
              value={state.discord.channelId}
              onChange={(v) =>
                setState((s) => ({
                  ...s,
                  discord: { ...s.discord, channelId: v },
                }))
              }
              placeholder="1234567890123456789"
              mono
              hint="Right-click a channel in Discord (with Developer Mode on) → Copy Channel ID."
            />

            <Separator className="my-2" />

            <div className="flex justify-between">
              <Button variant="ghost" onClick={() => setStep(1)}>
                ← Back
              </Button>
              <Button
                onClick={handleFinish}
                disabled={!discordValid || submitting}
              >
                {submitting ? "Saving..." : "Finish setup →"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepIndicator — the dotted progress strip above the active card.
// Two tiny rows: a numbered tag and the step title. Matches career-gap's
// understated "01/02" style.
// ---------------------------------------------------------------------------
function StepIndicator({ step }: { step: 1 | 2 }) {
  const steps = [
    { n: 1, title: "Reddit" },
    { n: 2, title: "Discord" },
  ];
  return (
    <ol className="flex items-center gap-4 text-xs font-mono text-foreground/40">
      {steps.map((s, i) => {
        const active = s.n === step;
        const done = s.n < step;
        return (
          <li key={s.n} className="flex items-center gap-4">
            <span
              className={
                active
                  ? "text-foreground"
                  : done
                    ? "text-foreground/70"
                    : "text-foreground/40"
              }
            >
              {String(s.n).padStart(2, "0")} · {s.title}
            </span>
            {i < steps.length - 1 && (
              <span className="w-8 h-px bg-foreground/15" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Field — labeled input with optional hint line. Used throughout the wizard
// to keep field spacing/styling consistent.
// ---------------------------------------------------------------------------
function Field({
  id,
  label,
  value,
  onChange,
  type = "text",
  placeholder,
  mono = false,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: "text" | "password";
  placeholder?: string;
  mono?: boolean;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="text-sm">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={mono ? "font-mono text-sm" : undefined}
        autoComplete="off"
        spellCheck={false}
      />
      {hint && (
        <p className="text-xs text-foreground/50 leading-relaxed">{hint}</p>
      )}
    </div>
  );
}
