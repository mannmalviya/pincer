// Thin client for the Pincer agent (Node backend on Brev).
//
// One module-level base URL, one helper per endpoint we actually call from
// the dashboard. Keeps the agent's HTTP shape in one place so adding a new
// route (e.g. POST /comments) is a one-line edit, and so we never sprinkle
// hardcoded "http://localhost:8000" through React components.
//
// AGENT_BASE resolution:
//   1. NEXT_PUBLIC_AGENT_URL from `.env.local` (set this to the Brev public
//      URL once you deploy: `https://port-8000-xxxxxx.brevlab.com`).
//   2. Falls back to `http://localhost:8000` for laptop dev when you're
//      running `npm run dev` in agent/ alongside the dashboard.
//
// All calls are fire-and-forget for now: failures get swallowed and logged
// to the browser console rather than thrown, because agent unavailability
// must NEVER block the UI's primary flow (publishing a post, etc).

export const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000";

// Register a freshly-published (or backfilled) post URL with the agent so
// it gets a snapshot row and shows up in the watch loop. Called after the
// sidecar returns a permalink from /post. Errors are swallowed: if the
// agent is offline, the post still went out, we just won't see analytics.
export async function registerPost(input: {
  url: string;
  source: "published" | "backfill";
  watch?: boolean;
}): Promise<void> {
  try {
    const res = await fetch(`${AGENT_BASE}/posts`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: input.url,
        source: input.source,
        watch: input.watch ?? true,
      }),
    });
    if (!res.ok) {
      // 4xx/5xx: log but don't throw. The UI shouldn't tell the user a
      // publish failed when the publish itself worked, just the side-channel
      // analytics registration didn't.
      const text = await res.text().catch(() => "");
      console.warn(
        `[agent] registerPost returned ${res.status}: ${text.slice(0, 200)}`,
      );
    }
  } catch (err) {
    // Network-level failure (agent down, DNS, CORS). Same swallow logic.
    console.warn(
      `[agent] registerPost network error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

// Overview counts the dashboard renders in the top cards. Mirrors the
// shape returned by GET /stats on the agent.
export type AgentStats = {
  posts_total: number;
  posts_watching: number;
  pending_replies: number;
  comments_tracked: number;
};

// One row in the dashboard's flat comments feed. The agent inlines the
// originating post's platform + title + permalink so the UI doesn't need
// a follow-up lookup per comment.
export type AgentComment = {
  id: number;
  external_id: string;
  author: string | null;
  body: string | null;
  posted_at: number | null;
  fetched_at: number;
  // Reddit only — HN doesn't expose per-comment karma, so this is null
  // for every HN row.
  score: number | null;
  parent_external_id: string | null;
  post_id: number;
  platform: "reddit" | "hn";
  post_title: string | null;
  post_permalink: string;
};

// Returns null on failure (network error or 5xx) so the UI can render a
// dashed "agent offline" state instead of crashing.
export async function fetchComments(
  limit = 50,
): Promise<AgentComment[] | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/comments?limit=${limit}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { comments: AgentComment[] };
    return data.comments;
  } catch {
    return null;
  }
}

// Agent-wide user-tweakable knobs, surfaced on /dashboard/settings.
// base_poll_interval_seconds is the scheduler period for the watch loop;
// adaptive_polling_enabled stretches that interval for older posts.
export type AgentSettings = {
  base_poll_interval_seconds: number;
  adaptive_polling_enabled: boolean;
};

// Onboarding: structured documentation + typed clarifying questions the
// agent returns from /onboarding/analyze. Mirrors the agent's
// ProjectDocumentation / ProjectQuestion / ProjectAnswer types one-to-one
// so they serialize cleanly over JSON.
export type ProjectDocumentation = {
  summary: string;
  key_features: string[];
  tech_stack: string[];
  target_audience: string;
  voice_guidance: string;
  things_to_avoid: string[];
};

export type ProjectQuestionOption = {
  label: string;
  description?: string;
};

export type ProjectQuestion =
  | {
      id: string;
      type: "mcq";
      text: string;
      options: ProjectQuestionOption[];
    }
  | { id: string; type: "text"; text: string };

export type ProjectAnswer = { id: string; answer: string };

export type AnalyzeRepoResult =
  | { ok: true; documentation: ProjectDocumentation; questions: ProjectQuestion[] }
  | { ok: false; code: string; message: string };

export async function analyzeRepo(
  repoUrl?: string,
  token?: string,
): Promise<AnalyzeRepoResult> {
  // Empty/undefined repoUrl triggers the agent's fallback questionnaire
  // path (a generic 4-question survey instead of README-driven). We omit
  // the key entirely rather than send "" so the body matches the agent's
  // optional-field schema.
  const trimmedUrl = repoUrl?.trim() ?? "";
  try {
    const res = await fetch("/api/onboarding/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...(trimmedUrl.length > 0 ? { repo_url: trimmedUrl } : {}),
        ...(token ? { token } : {}),
      }),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } })
        ?.error;
      return {
        ok: false,
        code: err?.code ?? `http_${res.status}`,
        message: err?.message ?? `HTTP ${res.status}`,
      };
    }
    const data = body as {
      documentation: ProjectDocumentation;
      questions: ProjectQuestion[];
    };
    return {
      ok: true,
      documentation: data.documentation,
      questions: data.questions,
    };
  } catch (err) {
    return {
      ok: false,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Save the user's answers to the analyze-step questions. The agent
// persists them on its project_context row; the reply route then reads
// them as additional grounding for drafted comment replies.
export async function saveOnboardingAnswers(
  answers: ProjectAnswer[],
): Promise<boolean> {
  try {
    const res = await fetch("/api/onboarding/answers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Ask the agent to draft a reply for a watched comment via NIM (Nemotron
// Super). Returns null on transport-level failure; surfaces the agent's
// own { error: { code, message } } envelope on a non-2xx response so the
// UI can show useful diagnostics (especially the "nim_not_configured"
// case where the agent has no NIM_API_KEY).
export type DraftReplyResult =
  | { ok: true; draft: string; model: string }
  | { ok: false; code: string; message: string };

export async function draftReply(
  commentId: number,
): Promise<DraftReplyResult> {
  try {
    const res = await fetch(
      `${AGENT_BASE}/comments/${commentId}/draft-reply`,
      { method: "POST" },
    );
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const err = (body as { error?: { code?: string; message?: string } })
        ?.error;
      return {
        ok: false,
        code: err?.code ?? `http_${res.status}`,
        message: err?.message ?? `HTTP ${res.status}`,
      };
    }
    const data = body as { draft: string; model: string };
    return { ok: true, draft: data.draft, model: data.model };
  } catch (err) {
    return {
      ok: false,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

// Probe the agent's /health endpoint. Returns true on a 2xx response,
// false otherwise (network error, 5xx, CORS, etc). Used by the dashboard
// header to render a live connectivity indicator.
export async function pingAgent(): Promise<boolean> {
  try {
    const res = await fetch(`${AGENT_BASE}/health`, { cache: "no-store" });
    return res.ok;
  } catch {
    return false;
  }
}

export async function fetchSettings(): Promise<AgentSettings | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/settings`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as AgentSettings;
  } catch {
    return null;
  }
}

export async function patchSettings(
  patch: Partial<AgentSettings>,
): Promise<AgentSettings | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    return (await res.json()) as AgentSettings;
  } catch {
    return null;
  }
}

// Fetch the live counts. Returns null on failure so callers can render a
// graceful "agent offline" placeholder rather than crashing the page.
export async function fetchStats(): Promise<AgentStats | null> {
  try {
    const res = await fetch(`${AGENT_BASE}/stats`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as AgentStats;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub PAT integration.
//
// These helpers hit the dashboard's own /api/auth/github/* proxy routes
// (not the agent directly) so the browser doesn't have to deal with
// CORS / Brev auth-wall behaviour. The agent is the system of record;
// these are just thin pass-throughs.
// ---------------------------------------------------------------------------

export type GithubStatus = {
  // The agent has a stored PAT that just verified successfully.
  connected: boolean;
  // GitHub login of the authenticated user, present when connected.
  login?: string;
  // True if the dashboard could reach the agent. False usually means the
  // agent is offline or the AGENT_BASE URL is wrong.
  agent_reachable: boolean;
};

export async function fetchGithubStatus(): Promise<GithubStatus> {
  try {
    const res = await fetch("/api/auth/github/status", { cache: "no-store" });
    if (!res.ok) {
      return { connected: false, agent_reachable: false };
    }
    return (await res.json()) as GithubStatus;
  } catch {
    return { connected: false, agent_reachable: false };
  }
}

export type SavePatResult =
  | { ok: true; login: string | null }
  | { ok: false; code: string; message: string };

// Save a personal access token to the agent. The agent verifies it
// against GitHub's /user before storing, so a 400 here means GitHub
// rejected the token (most likely a typo or an expired PAT).
export async function saveGithubPat(token: string): Promise<SavePatResult> {
  try {
    const res = await fetch("/api/auth/github/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: token }),
    });
    const data = (await res.json().catch(() => null)) as
      | { ok?: boolean; login?: string | null; error?: string; message?: string }
      | null;
    if (!res.ok || data?.ok === false) {
      return {
        ok: false,
        code: data?.error ?? `http_${res.status}`,
        message:
          data?.message ??
          (res.status === 400
            ? "GitHub did not accept that token."
            : `HTTP ${res.status}`),
      };
    }
    return { ok: true, login: data?.login ?? null };
  } catch (err) {
    return {
      ok: false,
      code: "network_error",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function disconnectGithub(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/github/disconnect", { method: "POST" });
    return res.ok;
  } catch {
    return false;
  }
}
