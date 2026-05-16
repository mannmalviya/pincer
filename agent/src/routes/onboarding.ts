// Onboarding endpoints, two phases:
//
//   POST /onboarding/analyze
//     body: { repo_url, token? }
//     Fetches the repo's README via the GitHub REST API and asks Nemotron
//     Super to produce a structured ProjectDocumentation block + a typed
//     list of clarifying questions. Both fields together make the
//     drafted-reply prompt project-aware.
//
//   POST /onboarding/answers
//     body: { answers: [{id, answer}] }
//     Persists the typed Q/A pairs onto project_context. The reply route
//     reads these as grounding for drafted comment replies.
//
// Token resolution order for the README fetch:
//   1. token in the request body (one-off PAT, used and not stored here)
//   2. the stored GitHub PAT (saved via POST /integrations/github/connect)
//   3. unauthenticated (works for public repos, rate-limited to 60 req/hr
//      per IP which is fine for an onboarding flow)
//
// Previously this endpoint shelled out to `git clone` and sampled README +
// source files. We replaced that with a single REST call because (a) it
// removes the `git` binary dependency on the host, (b) it never touches
// source code (purely README-based), and (c) it works inside Brev's
// sandbox without the egress and disk concerns of a clone.

import type { FastifyInstance } from "fastify";

import { NIM_ANALYZE_MODEL } from "../config.js";
import { log } from "../lib/log.js";
import { getGithubToken } from "../lib/github-oauth.js";
import { chatComplete, NimError, nimConfigured } from "../lib/nim.js";
import {
  getProjectContext,
  setProjectContext,
  type ProjectAnswer,
  type ProjectDocumentation,
  type ProjectQuestion,
  type ProjectQuestionOption,
} from "../lib/project-context.js";

const ANALYZE_BODY = {
  type: "object",
  required: ["repo_url"],
  properties: {
    repo_url: { type: "string", minLength: 1, maxLength: 500 },
    token: { type: "string", minLength: 1, maxLength: 200 },
  },
  additionalProperties: false,
} as const;

const ANSWERS_BODY = {
  type: "object",
  required: ["answers"],
  properties: {
    answers: {
      type: "array",
      items: {
        type: "object",
        required: ["id", "answer"],
        properties: {
          id: { type: "string", minLength: 1, maxLength: 100 },
          answer: { type: "string", maxLength: 4000 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

// Hard cap on the README excerpt we send to Nemotron. Real-world READMEs
// are usually well under this; the cap keeps a pathological 200KB README
// from blowing out the context window.
const MAX_README_BYTES = 50_000;

// Parse a GitHub repo URL into { owner, repo }. Accepts:
//   https://github.com/owner/repo
//   https://github.com/owner/repo.git
//   https://github.com/owner/repo/tree/main/...   (path suffix ignored)
//   http://github.com/owner/repo
// Returns null on anything we can't recognize so the caller can return
// a 400 with a useful message.
function parseGithubUrl(url: string): { owner: string; repo: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!/github\.com$/i.test(parsed.hostname)) return null;
  // Strip leading slash, drop trailing slashes, take the first two segments.
  const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
  const owner = parts[0];
  const rawRepo = parts[1];
  if (!owner || !rawRepo) return null;
  const repo = rawRepo.replace(/\.git$/i, "");
  if (repo.length === 0) return null;
  return { owner, repo };
}

// Fetch the repo's README via the GitHub REST API. Token is optional;
// without one we still work for public repos (60 req/hr per IP), with
// one we get 5000 req/hr and access to private repos the token can see.
// Returns the raw markdown string, or an Error-typed object the caller
// can map to an HTTP status.
type ReadmeFetchResult =
  | { ok: true; readme: string }
  | { ok: false; status: number; message: string };

async function fetchReadme(
  owner: string,
  repo: string,
  token: string | null,
): Promise<ReadmeFetchResult> {
  const headers: Record<string, string> = {
    // Use the raw media type so GitHub returns the README body directly
    // instead of a base64-encoded JSON envelope. Saves us a decode step.
    Accept: "application/vnd.github.raw",
    "User-Agent": "pincer-agent",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      { headers },
    );
  } catch (err) {
    return {
      ok: false,
      status: 502,
      message:
        err instanceof Error
          ? `Network error talking to GitHub: ${err.message}`
          : "Network error talking to GitHub",
    };
  }

  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      message:
        "GitHub returned 404. The repo may be private (connect GitHub or pass a PAT) or the URL may be wrong.",
    };
  }
  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      status: res.status,
      message:
        "GitHub denied the request. If this is a private repo, connect GitHub from Settings (or pass a PAT with the `repo` scope).",
    };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return {
      ok: false,
      status: 502,
      message: `GitHub returned ${res.status}: ${body.slice(0, 200)}`,
    };
  }

  const text = await res.text();
  // Cap to keep the prompt bounded. A README longer than 50KB is unusual
  // and the bottom is almost always license / contributing boilerplate,
  // which adds noise more than signal.
  return { ok: true, readme: text.slice(0, MAX_README_BYTES) };
}

type AnalyzeResponse = {
  documentation: ProjectDocumentation;
  questions: ProjectQuestion[];
};

// Hard parse Nemotron's JSON output. Nemotron Super tends to wrap JSON in
// prose or code fences; we pull the first {...} block and validate it.
// Returns null on any parse / shape failure so the caller can decide
// whether to surface a partial result.
function parseAnalyzeResponse(text: string): AnalyzeResponse | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  const d = (o.documentation as Record<string, unknown> | undefined) ?? {};
  if (typeof d !== "object" || d === null) return null;

  const stringArray = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      : [];

  const documentation: ProjectDocumentation = {
    summary: typeof d.summary === "string" ? d.summary.trim() : "",
    key_features: stringArray(d.key_features),
    tech_stack: stringArray(d.tech_stack),
    target_audience:
      typeof d.target_audience === "string" ? d.target_audience.trim() : "",
    voice_guidance:
      typeof d.voice_guidance === "string" ? d.voice_guidance.trim() : "",
    things_to_avoid: stringArray(d.things_to_avoid),
  };

  const questionsRaw = Array.isArray(o.questions) ? o.questions : [];
  const questions: ProjectQuestion[] = [];
  for (const q of questionsRaw) {
    if (typeof q !== "object" || q === null) continue;
    const qo = q as Record<string, unknown>;
    const id = typeof qo.id === "string" ? qo.id : null;
    const text = typeof qo.text === "string" ? qo.text.trim() : null;
    if (!id || !text) continue;
    if (qo.type === "mcq" && Array.isArray(qo.options)) {
      const options: ProjectQuestionOption[] = [];
      for (const opt of qo.options) {
        if (typeof opt !== "object" || opt === null) continue;
        const oo = opt as Record<string, unknown>;
        if (typeof oo.label !== "string" || !oo.label.trim()) continue;
        options.push({
          label: oo.label.trim(),
          description:
            typeof oo.description === "string" ? oo.description.trim() : undefined,
        });
      }
      if (options.length >= 2) {
        questions.push({ id, type: "mcq", text, options });
      }
    } else if (qo.type === "text") {
      questions.push({ id, type: "text", text });
    }
  }

  if (!documentation.summary && questions.length === 0) return null;
  return { documentation, questions };
}

export function registerOnboardingRoutes(app: FastifyInstance): void {
  app.post<{ Body: { repo_url: string; token?: string } }>(
    "/onboarding/analyze",
    { schema: { body: ANALYZE_BODY } },
    async (req, reply) => {
      const repoUrl = req.body.repo_url.trim();
      const requestToken = req.body.token?.trim();

      if (!nimConfigured()) {
        return reply.code(503).send({
          error: {
            code: "nim_not_configured",
            message: "Set NIM_API_KEY on the agent to enable repo analysis.",
          },
        });
      }

      const parsedUrl = parseGithubUrl(repoUrl);
      if (parsedUrl === null) {
        return reply.code(400).send({
          error: {
            code: "invalid_repo_url",
            message:
              "Repo URL must look like https://github.com/owner/repo.",
          },
        });
      }

      // Token precedence: per-request body token wins (lets the user
      // experiment with a one-off PAT without saving it), then the stored
      // OAuth token, then unauthenticated.
      const token = requestToken ?? getGithubToken();
      const fetchResult = await fetchReadme(
        parsedUrl.owner,
        parsedUrl.repo,
        token,
      );
      if (!fetchResult.ok) {
        return reply.code(fetchResult.status).send({
          error: {
            code: "github_fetch_failed",
            message: fetchResult.message,
          },
        });
      }

      const system = [
        "You are analyzing a software project to help its creator market it.",
        "Read the supplied README and return STRICTLY VALID JSON with two top-level keys: `documentation` and `questions`.",
        "",
        "`documentation` is an object describing what you learned. Include the keys that make sense for this project. Strongly preferred keys:",
        " - summary: short prose, what the project does and who it's for. Plain language, no marketing speak.",
        " - key_features: array of short feature strings.",
        " - tech_stack: array naming languages, frameworks, and key infra you saw mentioned.",
        " - target_audience: one sentence on who this is for.",
        " - voice_guidance: one sentence on the tone the assistant should use, inferred from the README's voice.",
        " - things_to_avoid: array of claims or framings the assistant should NOT make. Empty array is fine if nothing comes to mind.",
        "Omit any field where you genuinely have no signal; never invent.",
        "",
        "`questions` is an array of clarifying questions targeting things the README doesn't tell you. Ask as many or as few as you need to feel confident drafting on-brand replies, ranging from zero (you're already confident) up to roughly a dozen (README is opaque, audience unclear).",
        "Each question is an object: { id, type, text, options? }",
        " - `id` is a short stable slug like 'audience' or 'tone'. Unique within the array.",
        " - `type` is either 'mcq' (single-choice with labeled options) or 'text' (free-form).",
        " - `text` is the question shown to the user.",
        " - `options` is required when type is 'mcq'. Each option is { label: short choice, description: one-sentence explainer }. Provide enough options to cover the realistic answers, typically 2-5.",
        "Mix question types as you see fit. Prefer 'mcq' when you can enumerate likely answers because users answer those faster.",
        "",
        "Good question targets: target audience boundaries, what NOT to claim, the single feature to lead with, technical depth to assume, voice on different platforms, who the project is meant to compete with.",
        "Avoid asking about pricing, business model, or roadmap unless the README already hints at them.",
        "",
        "Return ONLY the JSON object. No prose before or after, no markdown code fences.",
      ].join("\n");

      let modelText: string;
      try {
        modelText = await chatComplete({
          model: NIM_ANALYZE_MODEL,
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: `Repo URL: ${repoUrl}\n\nREADME:\n${fetchResult.readme}`,
            },
          ],
          temperature: 0.3,
          max_tokens: 16000,
        });
      } catch (err) {
        if (err instanceof NimError) {
          return reply.code(502).send({
            error: { code: err.code, message: err.message },
          });
        }
        throw err;
      }

      const parsed = parseAnalyzeResponse(modelText);
      if (parsed === null) {
        log.warn("analyze: model output unparseable", {
          chars: modelText.length,
          head: modelText.slice(0, 400),
          tail: modelText.slice(-400),
        });
        return reply.code(502).send({
          error: {
            code: "model_output_malformed",
            message:
              "Nemotron returned output we couldn't parse as the expected JSON shape.",
          },
        });
      }
      setProjectContext({
        repo_url: repoUrl,
        documentation: parsed.documentation,
        questions: parsed.questions,
        // Reset answers: fresh analyze means stale answers are out.
        answers: [],
      });
      log.info("onboarding analyze", {
        repoUrl,
        summaryChars: parsed.documentation.summary.length,
        questions: parsed.questions.length,
      });
      return {
        documentation: parsed.documentation,
        questions: parsed.questions,
      };
    },
  );

  app.post<{
    Body: { answers: ProjectAnswer[] };
  }>(
    "/onboarding/answers",
    { schema: { body: ANSWERS_BODY } },
    async (req) => {
      const ctx = setProjectContext({ answers: req.body.answers });
      log.info("onboarding answers saved", { count: req.body.answers.length });
      return {
        documentation: ctx.documentation,
        questions: ctx.questions,
        answers: ctx.answers,
        updated_at: ctx.updated_at,
      };
    },
  );

  // Lightweight read endpoint so the dashboard can show the captured
  // context on the settings page or pre-fill the onboarding form.
  app.get("/onboarding/context", async () => {
    const ctx = getProjectContext();
    return {
      repo_url: ctx.repo_url,
      documentation: ctx.documentation,
      questions: ctx.questions,
      answers: ctx.answers,
      updated_at: ctx.updated_at,
    };
  });
}
