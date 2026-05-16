"use client";

import { useState, type ComponentType } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FaReddit,
  FaHackerNews,
  FaDiscord,
  FaXTwitter,
  FaInstagram,
  FaTiktok,
} from "react-icons/fa6";

import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";

// ---------------------------------------------------------------------------
// OnboardingWizard — dynamic multi-platform setup flow.
//
// Step 0  — "Where do you want to launch?" multi-select across the six
//           supported platforms. Only the picked ones contribute steps to
//           the rest of the wizard, so a user marketing on just Reddit + X
//           never sees the Instagram or TikTok screens.
//
// Step 1..N — One credential card per selected platform, in PLATFORM_ORDER.
//           Reddit and Discord have real fields (matched to the agent's
//           snoowrap / discord.js wiring in PLAN.md). The others are stubs
//           with plausible-looking fields; they'll get wired up to OpenClaw
//           skills in a later pass.
//
// Submission POSTs collected credentials to /api/accounts (not implemented
// yet — call is swallowed) and then routes to /dashboard, so the UI can be
// validated end-to-end before the backend lands.
// ---------------------------------------------------------------------------

// The canonical list of platforms Pincer can target. Order here drives the
// order steps appear in. Add a new platform by extending this union + the
// PLATFORM_META + INITIAL_CREDS + platformValid map below.
type Platform = "reddit" | "hn" | "discord" | "x" | "instagram" | "tiktok";

const PLATFORM_ORDER: Platform[] = [
  "reddit",
  "hn",
  "discord",
  "x",
  "instagram",
  "tiktok",
];

// Display metadata for the selection step + step indicator.
//
// `icon`  — react-icons component for the brand glyph.
// `color` — official brand color, passed straight as inline `color` so the
//           icon renders in its true hue regardless of our theme tokens.
//           X is intentionally left as `currentColor` so it inherits the
//           foreground (black on light, white on dark) — X has no fixed
//           accent color.
type PlatformMeta = {
  label: string;
  tagline: string;
  badge?: string;
  icon: ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color: string;
};

const PLATFORM_META: Record<Platform, PlatformMeta> = {
  reddit: {
    label: "Reddit",
    tagline: "Submit to subreddits, monitor comments via snoowrap.",
    icon: FaReddit,
    color: "#FF4500",
  },
  hn: {
    label: "Hacker News",
    tagline: "Read-only analytics via Algolia. Posting wired later.",
    badge: "read-only",
    icon: FaHackerNews,
    color: "#FF6600",
  },
  discord: {
    label: "Discord",
    tagline: "Send to a server channel via a bot you control.",
    icon: FaDiscord,
    color: "#5865F2",
  },
  x: {
    label: "X",
    tagline: "Post via the v2 API. Free tier rate-limited.",
    badge: "stub",
    icon: FaXTwitter,
    color: "currentColor",
  },
  instagram: {
    label: "Instagram",
    tagline: "Business accounts via the Meta Graph API.",
    badge: "stub",
    icon: FaInstagram,
    color: "#E4405F",
  },
  tiktok: {
    label: "TikTok",
    tagline: "Content Posting API. Sandbox by default.",
    badge: "stub",
    icon: FaTiktok,
    color: "currentColor",
  },
};

// Full credential bag. Always carries every platform so we don't have to
// narrow types per step — fields not relevant to the user's selection are
// simply never edited and skipped at submit time.
type CredsByPlatform = {
  reddit: {
    clientId: string;
    clientSecret: string;
    username: string;
    password: string;
    userAgent: string;
  };
  hn: {
    username: string;
  };
  discord: {
    botToken: string;
    channelId: string;
  };
  x: {
    apiKey: string;
    apiSecret: string;
  };
  instagram: {
    accessToken: string;
  };
  tiktok: {
    clientKey: string;
    accessToken: string;
  };
};

const INITIAL_CREDS: CredsByPlatform = {
  reddit: {
    clientId: "",
    clientSecret: "",
    username: "",
    password: "",
    userAgent: "pincer/0.1 (by /u/yourname)",
  },
  hn: {
    username: "",
  },
  discord: {
    botToken: "",
    channelId: "",
  },
  x: {
    apiKey: "",
    apiSecret: "",
  },
  instagram: {
    accessToken: "",
  },
  tiktok: {
    clientKey: "",
    accessToken: "",
  },
};

// Per-platform "are all required fields filled?" check. Keeps the Next
// button's enabled-logic out of each step's render code.
function platformValid<P extends Platform>(
  platform: P,
  creds: CredsByPlatform[P],
): boolean {
  switch (platform) {
    case "reddit": {
      const c = creds as CredsByPlatform["reddit"];
      return Boolean(
        c.clientId.trim() &&
          c.clientSecret.trim() &&
          c.username.trim() &&
          c.password.trim() &&
          c.userAgent.trim(),
      );
    }
    case "hn": {
      // HN posting isn't implemented yet — accept the step even with an
      // empty username so the user isn't blocked.
      return true;
    }
    case "discord": {
      const c = creds as CredsByPlatform["discord"];
      return Boolean(c.botToken.trim() && c.channelId.trim());
    }
    case "x": {
      const c = creds as CredsByPlatform["x"];
      return Boolean(c.apiKey.trim() && c.apiSecret.trim());
    }
    case "instagram": {
      const c = creds as CredsByPlatform["instagram"];
      return Boolean(c.accessToken.trim());
    }
    case "tiktok": {
      const c = creds as CredsByPlatform["tiktok"];
      return Boolean(c.clientKey.trim() && c.accessToken.trim());
    }
  }
}

// ---------------------------------------------------------------------------
// PlatformCardTitle — shared title row for the per-platform credential steps.
// Renders the platform's brand glyph (in its official colour) next to the
// step's heading, so each step instantly reads as e.g. "🔴 Reddit" instead of
// a bare wordmark. Centralised here so all six steps stay visually identical.
// ---------------------------------------------------------------------------
function PlatformCardTitle({ platform }: { platform: Platform }) {
  const meta = PLATFORM_META[platform];
  const Icon = meta.icon;
  return (
    <CardTitle className="font-serif text-2xl tracking-tight flex items-center gap-3">
      <Icon
        className="shrink-0 text-2xl"
        style={{ color: meta.color }}
        aria-hidden
      />
      {meta.label}
    </CardTitle>
  );
}

export function OnboardingWizard() {
  const router = useRouter();

  // Which platforms the user has chosen (step 0 output). Order in this
  // array doesn't matter for navigation — we always walk PLATFORM_ORDER.
  const [selected, setSelected] = useState<Platform[]>([]);

  // All credentials, regardless of selection. See note on CredsByPlatform.
  const [creds, setCreds] = useState<CredsByPlatform>(INITIAL_CREDS);

  // Current step index. 0 is always the selection step; 1..N walk
  // PLATFORM_ORDER filtered by `selected`.
  const [stepIndex, setStepIndex] = useState(0);
  const [submitting, setSubmitting] = useState(false);

  // The actual step list for this run. "select" is the first step; the
  // rest are the selected platforms in canonical order.
  const steps: Array<"select" | Platform> = [
    "select",
    ...PLATFORM_ORDER.filter((p) => selected.includes(p)),
  ];

  const currentStep = steps[stepIndex];
  const isLastStep = stepIndex === steps.length - 1;

  // Selection step is valid once anything is checked; per-platform steps
  // use the platformValid check. We type-narrow inside platformValid by
  // passing both platform key and the matching creds slice.
  const currentValid =
    currentStep === "select"
      ? selected.length > 0
      : platformValid(currentStep, creds[currentStep]);

  function togglePlatform(p: Platform) {
    setSelected((cur) =>
      cur.includes(p) ? cur.filter((x) => x !== p) : [...cur, p],
    );
  }

  // Generic "update one field on one platform" helper so step components
  // don't have to repeat the immutable-update boilerplate.
  function updateCreds<P extends Platform, K extends keyof CredsByPlatform[P]>(
    platform: P,
    key: K,
    value: CredsByPlatform[P][K],
  ) {
    setCreds((prev) => ({
      ...prev,
      [platform]: { ...prev[platform], [key]: value },
    }));
  }

  async function handleFinish() {
    setSubmitting(true);
    try {
      // Only ship the creds for platforms the user actually selected. The
      // backend doesn't exist yet — failure is swallowed so dev can proceed.
      const payload = {
        platforms: selected,
        creds: Object.fromEntries(selected.map((p) => [p, creds[p]])),
      };
      await fetch("/api/accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {});
      router.push("/dashboard");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <StepIndicator steps={steps} current={stepIndex} />

      {currentStep === "select" && (
        <SelectStep
          selected={selected}
          onToggle={togglePlatform}
        />
      )}

      {currentStep === "reddit" && (
        <RedditStep
          value={creds.reddit}
          onChange={(k, v) => updateCreds("reddit", k, v)}
        />
      )}

      {currentStep === "hn" && (
        <HackerNewsStep
          value={creds.hn}
          onChange={(k, v) => updateCreds("hn", k, v)}
        />
      )}

      {currentStep === "discord" && (
        <DiscordStep
          value={creds.discord}
          onChange={(k, v) => updateCreds("discord", k, v)}
        />
      )}

      {currentStep === "x" && (
        <XStep value={creds.x} onChange={(k, v) => updateCreds("x", k, v)} />
      )}

      {currentStep === "instagram" && (
        <InstagramStep
          value={creds.instagram}
          onChange={(k, v) => updateCreds("instagram", k, v)}
        />
      )}

      {currentStep === "tiktok" && (
        <TikTokStep
          value={creds.tiktok}
          onChange={(k, v) => updateCreds("tiktok", k, v)}
        />
      )}

      {/* Footer nav — Cancel on first step, Back otherwise; Next/Finish on the right. */}
      <div className="flex justify-between">
        {stepIndex === 0 ? (
          <Link href="/" className={buttonVariants({ variant: "ghost" })}>
            Cancel
          </Link>
        ) : (
          <Button
            variant="ghost"
            onClick={() => setStepIndex((s) => s - 1)}
          >
            ← Back
          </Button>
        )}

        {isLastStep ? (
          <Button
            onClick={handleFinish}
            disabled={!currentValid || submitting}
          >
            {submitting ? "Saving..." : "Finish setup →"}
          </Button>
        ) : (
          <Button
            onClick={() => setStepIndex((s) => s + 1)}
            disabled={!currentValid}
          >
            Next →
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step indicator — small mono dotline above the active card.
// Renders "01 · Select", "02 · Reddit", etc. Highlights the active step,
// fades done/upcoming.
// ---------------------------------------------------------------------------
function StepIndicator({
  steps,
  current,
}: {
  steps: Array<"select" | Platform>;
  current: number;
}) {
  return (
    <ol className="flex items-center gap-3 flex-wrap text-xs font-mono text-foreground/40">
      {steps.map((s, i) => {
        const active = i === current;
        const done = i < current;
        const label = s === "select" ? "Select" : PLATFORM_META[s].label;
        return (
          <li key={`${s}-${i}`} className="flex items-center gap-3">
            <span
              className={
                active
                  ? "text-foreground"
                  : done
                    ? "text-foreground/70"
                    : "text-foreground/40"
              }
            >
              {String(i + 1).padStart(2, "0")} · {label}
            </span>
            {i < steps.length - 1 && (
              <span className="w-6 h-px bg-foreground/15" aria-hidden />
            )}
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// Step 0 — platform multi-select.
// Grid of clickable cards. Clicked card flips the platform in/out of the
// `selected` array; visual state shows an orange dot + brand-tinted border.
// ---------------------------------------------------------------------------
function SelectStep({
  selected,
  onToggle,
}: {
  selected: Platform[];
  onToggle: (p: Platform) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="font-serif text-2xl tracking-tight">
          Where do you want to launch?
        </CardTitle>
        <CardDescription>
          Pick every platform Pincer should post on. You can change this
          later from Settings.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ul className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {PLATFORM_ORDER.map((p) => {
            const meta = PLATFORM_META[p];
            const checked = selected.includes(p);
            const id = `platform-${p}`;
            const Icon = meta.icon;
            return (
              <li key={p}>
                {/* The whole row is one click target. <label htmlFor> wires
                    label-click → checkbox-toggle natively. Tabbing into the
                    checkbox still works because it's a real input under the
                    hood (base-ui Root). */}
                <label
                  htmlFor={id}
                  className={
                    "flex items-center gap-3 p-4 rounded-xl border cursor-pointer transition-colors " +
                    (checked
                      ? "border-[color:var(--brand)] bg-[color:var(--brand)]/5"
                      : "border-foreground/10 hover:border-foreground/30 hover:bg-foreground/5")
                  }
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={() => onToggle(p)}
                  />

                  {/* Brand glyph in the platform's official color. */}
                  <Icon
                    className="shrink-0 text-2xl"
                    style={{ color: meta.color }}
                  />

                  <div className="flex flex-col gap-1 min-w-0">
                    <span className="font-semibold tracking-tight flex items-center gap-2">
                      {meta.label}
                      {meta.badge && (
                        <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/50 border border-foreground/15 rounded-full px-1.5 py-0.5">
                          {meta.badge}
                        </span>
                      )}
                    </span>
                    <span className="text-sm text-foreground/65 leading-relaxed">
                      {meta.tagline}
                    </span>
                  </div>
                </label>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step — Reddit credentials.
// snoowrap uses password-grant auth: all five fields are required.
// ---------------------------------------------------------------------------
function RedditStep({
  value,
  onChange,
}: {
  value: CredsByPlatform["reddit"];
  onChange: <K extends keyof CredsByPlatform["reddit"]>(
    key: K,
    val: CredsByPlatform["reddit"][K],
  ) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <PlatformCardTitle platform="reddit" />
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
          . Brand new accounts get auto-flagged by popular subreddits — test
          against <span className="font-mono">r/test</span> or a sub you
          moderate.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field
          id="reddit-client-id"
          label="Client ID"
          value={value.clientId}
          onChange={(v) => onChange("clientId", v)}
          placeholder="abc123..."
          mono
        />
        <Field
          id="reddit-client-secret"
          label="Client secret"
          type="password"
          value={value.clientSecret}
          onChange={(v) => onChange("clientSecret", v)}
          placeholder="••••••••••••"
          mono
        />
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Field
            id="reddit-username"
            label="Username"
            value={value.username}
            onChange={(v) => onChange("username", v)}
            placeholder="your_bot_account"
          />
          <Field
            id="reddit-password"
            label="Password"
            type="password"
            value={value.password}
            onChange={(v) => onChange("password", v)}
            placeholder="••••••••"
          />
        </div>
        <Field
          id="reddit-user-agent"
          label="User agent"
          value={value.userAgent}
          onChange={(v) => onChange("userAgent", v)}
          placeholder="pincer/0.1 (by /u/yourname)"
          mono
          hint="Reddit requires a unique user-agent string per app."
        />
        <Separator className="my-2" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step — Hacker News (read-only stub).
// HN has no official write API. We collect the username only so we can tag
// the user in future Browser-Harness driven submissions; everything else
// will come from the Algolia search API at runtime.
// ---------------------------------------------------------------------------
function HackerNewsStep({
  value,
  onChange,
}: {
  value: CredsByPlatform["hn"];
  onChange: <K extends keyof CredsByPlatform["hn"]>(
    key: K,
    val: CredsByPlatform["hn"][K],
  ) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <PlatformCardTitle platform="hn" />
        <CardDescription>
          HN has no official write API in v0 — Pincer reads upvotes and
          comment counts via Algolia. Posting plugs in later via Browser
          Harness.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field
          id="hn-username"
          label="Username (optional)"
          value={value.username}
          onChange={(v) => onChange("username", v)}
          placeholder="pg"
          mono
          hint="Used for analytics filtering once posting lands. Leave blank if you're not sure."
        />
        <Separator className="my-2" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step — Discord.
// Bot token + channel ID is the minimum to send a message via discord.js.
// ---------------------------------------------------------------------------
function DiscordStep({
  value,
  onChange,
}: {
  value: CredsByPlatform["discord"];
  onChange: <K extends keyof CredsByPlatform["discord"]>(
    key: K,
    val: CredsByPlatform["discord"][K],
  ) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <PlatformCardTitle platform="discord" />
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
          , invite it to your server, then paste its token and the channel
          ID Pincer should post to.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field
          id="discord-bot-token"
          label="Bot token"
          type="password"
          value={value.botToken}
          onChange={(v) => onChange("botToken", v)}
          placeholder="MTE••••••••"
          mono
        />
        <Field
          id="discord-channel-id"
          label="Channel ID"
          value={value.channelId}
          onChange={(v) => onChange("channelId", v)}
          placeholder="1234567890123456789"
          mono
          hint="Right-click a channel in Discord (with Developer Mode on) → Copy Channel ID."
        />
        <Separator className="my-2" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step — X (stub).
// API key + secret are the v2 app credentials. The free tier is heavily
// rate-limited; we'll surface that in the UI later.
// ---------------------------------------------------------------------------
function XStep({
  value,
  onChange,
}: {
  value: CredsByPlatform["x"];
  onChange: <K extends keyof CredsByPlatform["x"]>(
    key: K,
    val: CredsByPlatform["x"][K],
  ) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <PlatformCardTitle platform="x" />
        <CardDescription>
          Create a v2 app at{" "}
          <a
            href="https://developer.x.com/en/portal/dashboard"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            developer.x.com
          </a>
          . Wired to the agent in a later pass — the form here is a stub.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field
          id="x-api-key"
          label="API key"
          value={value.apiKey}
          onChange={(v) => onChange("apiKey", v)}
          placeholder="abc123..."
          mono
        />
        <Field
          id="x-api-secret"
          label="API secret"
          type="password"
          value={value.apiSecret}
          onChange={(v) => onChange("apiSecret", v)}
          placeholder="••••••••••••"
          mono
        />
        <Separator className="my-2" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step — Instagram (stub).
// Business accounts can post via a long-lived access token from the Meta
// Graph API. Single-field stub for now.
// ---------------------------------------------------------------------------
function InstagramStep({
  value,
  onChange,
}: {
  value: CredsByPlatform["instagram"];
  onChange: <K extends keyof CredsByPlatform["instagram"]>(
    key: K,
    val: CredsByPlatform["instagram"][K],
  ) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <PlatformCardTitle platform="instagram" />
        <CardDescription>
          Posting requires an Instagram Business account linked to a
          Facebook Page, then a long-lived access token from the Meta Graph
          API. Stubbed for now — the field below is captured but not used.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field
          id="ig-access-token"
          label="Long-lived access token"
          type="password"
          value={value.accessToken}
          onChange={(v) => onChange("accessToken", v)}
          placeholder="EAAG••••••••"
          mono
        />
        <Separator className="my-2" />
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Step — TikTok (stub).
// The Content Posting API uses a client key + access token. Sandbox mode
// is the default and most permissive for early testing.
// ---------------------------------------------------------------------------
function TikTokStep({
  value,
  onChange,
}: {
  value: CredsByPlatform["tiktok"];
  onChange: <K extends keyof CredsByPlatform["tiktok"]>(
    key: K,
    val: CredsByPlatform["tiktok"][K],
  ) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <PlatformCardTitle platform="tiktok" />
        <CardDescription>
          Register a Content Posting API app at{" "}
          <a
            href="https://developers.tiktok.com/"
            target="_blank"
            rel="noopener noreferrer"
            className="underline underline-offset-4 hover:text-foreground"
          >
            developers.tiktok.com
          </a>
          . Stubbed for now — fields are captured but not used.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <Field
          id="tiktok-client-key"
          label="Client key"
          value={value.clientKey}
          onChange={(v) => onChange("clientKey", v)}
          placeholder="aw1234..."
          mono
        />
        <Field
          id="tiktok-access-token"
          label="Access token"
          type="password"
          value={value.accessToken}
          onChange={(v) => onChange("accessToken", v)}
          placeholder="••••••••••••"
          mono
        />
        <Separator className="my-2" />
      </CardContent>
    </Card>
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
