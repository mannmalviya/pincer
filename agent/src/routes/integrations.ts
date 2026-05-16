// GitHub integration endpoints. The dashboard saves a Personal Access
// Token here, the agent persists it, and the README fetcher in
// /onboarding/analyze (plus any future GitHub-using feature) reads it
// back. Any GitHub bearer token works: the verification step probes
// /user, which accepts both PATs and OAuth tokens identically.
//
// Three endpoints:
//   POST /integrations/github/connect    store a token { access_token }
//   POST /integrations/github/disconnect clear the stored token
//   GET  /integrations/github/status     { connected: boolean, login? }
//
// The status endpoint fetches the GitHub user's login name so the
// Settings UI can render "Connected as @octocat" instead of a generic
// "Connected" pill. A bad/revoked token reads as disconnected, keeping
// the UI honest.

import type { FastifyInstance } from "fastify";

import { log } from "../lib/log.js";
import {
  clearGithubToken,
  getGithubToken,
  setGithubToken,
} from "../lib/github-oauth.js";

const CONNECT_BODY = {
  type: "object",
  required: ["access_token"],
  properties: {
    access_token: { type: "string", minLength: 10, maxLength: 500 },
  },
  additionalProperties: false,
} as const;

// Minimal shape we read out of GitHub's /user endpoint. The full payload
// is much larger; we only need `login` for the UI label.
type GithubUser = { login?: string };

export function registerGithubIntegrationRoutes(app: FastifyInstance): void {
  // Persist the access token the dashboard's OAuth callback obtained from
  // GitHub. Returns just `{ ok: true }` plus the resolved login so the
  // dashboard can immediately render the connected state.
  app.post<{ Body: { access_token: string } }>(
    "/integrations/github/connect",
    { schema: { body: CONNECT_BODY } },
    async (req, reply) => {
      const { access_token } = req.body;
      // Verify the token actually works before we store it. A bad token
      // here is a programmer error (the dashboard's exchange step
      // produced garbage), but failing loudly is better than silently
      // accepting it and confusing the user later.
      const login = await fetchLogin(access_token);
      if (login === null) {
        return reply.code(400).send({
          error: {
            code: "github_token_invalid",
            message:
              "GitHub did not accept the supplied access token. Please reconnect.",
          },
        });
      }
      setGithubToken(access_token);
      log.info("github oauth connected", { login });
      return { ok: true, login };
    },
  );

  // Forget the token. Doesn't try to revoke it on GitHub's side; the user
  // can do that manually from github.com/settings/applications if they
  // want a full revoke.
  app.post("/integrations/github/disconnect", async () => {
    clearGithubToken();
    log.info("github oauth disconnected");
    return { ok: true };
  });

  // Lightweight check so the dashboard can render a connection chip and
  // a Connect/Disconnect button correctly on mount. We also re-probe the
  // token against GitHub so a revoked token surfaces as `connected: false`
  // even though a row still exists in the DB.
  app.get("/integrations/github/status", async () => {
    const token = getGithubToken();
    if (token === null) {
      return { connected: false as const };
    }
    const login = await fetchLogin(token);
    if (login === null) {
      // Token went bad (revoked, expired, scopes changed). Clear so the
      // UI matches reality and the next connect attempt starts clean.
      clearGithubToken();
      return { connected: false as const };
    }
    return { connected: true as const, login };
  });
}

// Probe GitHub's /user endpoint with the token. Returns the login on
// success, null on any failure (network, 4xx, malformed). Doesn't throw
// because every caller wants to treat "can't reach GitHub" and "bad
// token" as the same UX state: disconnected.
async function fetchLogin(token: string): Promise<string | null> {
  try {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "pincer-agent",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as GithubUser;
    return typeof data.login === "string" && data.login.length > 0
      ? data.login
      : null;
  } catch {
    return null;
  }
}
