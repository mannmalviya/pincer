// Onboarding endpoints, two phases:
//
//   POST /onboarding/analyze
//     body: { repo_url, token? }
//     1. Shallow-clones the repo to a temp dir.
//     2. Reads README + a handful of top-level files (capped by byte count).
//     3. Asks Nemotron Super to produce a 1-2 sentence project summary
//        plus 4-6 clarifying questions for the user.
//     4. Stores the summary on the singleton project_context row.
//     5. Returns { summary, questions } so the dashboard can prompt the user.
//
//   POST /onboarding/answers
//     body: { answers: [{question, answer}] }
//     Persists the Q/A pairs onto project_context. The reply route reads
//     these as additional grounding for drafted comment replies.
//
// Private repo support: pass a GitHub PAT in `token`. We embed it into
// the clone URL once and never store it; the PAT-bearing URL stays only
// in argv for the lifetime of the child_process.

import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { FastifyInstance } from "fastify";

import { NIM_REPLY_MODEL } from "../config.js";
import { log } from "../lib/log.js";
import { chatComplete, NimError, nimConfigured } from "../lib/nim.js";
import { getProjectContext, setProjectContext } from "../lib/project-context.js";

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
        required: ["question", "answer"],
        properties: {
          question: { type: "string", minLength: 1, maxLength: 500 },
          answer: { type: "string", maxLength: 4000 },
        },
        additionalProperties: false,
      },
    },
  },
  additionalProperties: false,
} as const;

// Hard caps so a giant repo can't blow out memory or NIM context.
const MAX_FILES = 12;
const MAX_BYTES = 60_000;
// Files we look for in priority order. README and package.json carry the
// most signal; we grab a sprinkle of source after that if budget remains.
const PRIORITY_FILES = [
  "README.md",
  "README",
  "readme.md",
  "package.json",
  "PLAN.md",
  "ARCHITECTURE.md",
  "docs/README.md",
];

function cloneArgs(repoUrl: string, token: string | undefined, dest: string) {
  // Embed PAT into the URL for private repos. Format used by GitHub for
  // HTTPS basic auth with a PAT: https://<token>@github.com/owner/repo
  let url = repoUrl;
  if (token && /^https?:\/\//.test(url)) {
    url = url.replace(/^https?:\/\//, (proto) => `${proto}${token}@`);
  }
  return ["clone", "--depth=1", "--single-branch", url, dest];
}

// Scrub a string so it can be returned to the HTTP caller without leaking
// auth material. Git's stderr on an auth failure sometimes echoes the
// full clone URL, including the PAT we embed for private repos. We
// replace any occurrence of the literal token with `***`, then also
// rewrite "https://<anything>@host/" → "https://***@host/" as a belt-
// and-suspenders catch for prefix variants.
function scrubSecrets(text: string, token: string | undefined): string {
  let out = text;
  if (token && token.length > 0) {
    out = out.split(token).join("***");
  }
  out = out.replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@");
  return out;
}

async function gitClone(
  repoUrl: string,
  token: string | undefined,
  dest: string,
): Promise<void> {
  const args = cloneArgs(repoUrl, token, dest);
  await new Promise<void>((res, rej) => {
    const child = spawn("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      // GIT_TERMINAL_PROMPT=0 prevents git from hanging on an auth prompt
      // for a private repo when no token was supplied.
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      // ENOENT etc — re-wrap with a user-actionable message instead of
      // the raw spawn error. The original message rarely helps the
      // dashboard user.
      rej(
        new Error(
          err.message.includes("ENOENT")
            ? "git is not installed on the agent host"
            : scrubSecrets(err.message, token),
        ),
      );
    });
    child.on("exit", (code) => {
      if (code === 0) res();
      else {
        const safe = scrubSecrets(stderr, token).slice(0, 300);
        rej(new Error(`git clone exited ${code}: ${safe}`));
      }
    });
  });
}

async function readRepoSnapshot(root: string): Promise<string> {
  const out: string[] = [];
  let bytes = 0;
  const seen = new Set<string>();

  async function tryFile(relPath: string): Promise<void> {
    if (seen.has(relPath)) return;
    const abs = resolve(root, relPath);
    try {
      const s = await stat(abs);
      if (!s.isFile()) return;
      const content = await readFile(abs, "utf-8");
      const sliced = content.slice(0, Math.max(0, MAX_BYTES - bytes));
      if (sliced.length === 0) return;
      out.push(`\n=== ${relPath} ===\n${sliced}`);
      bytes += sliced.length;
      seen.add(relPath);
    } catch {
      // Missing or unreadable file is fine; skip silently.
    }
  }

  for (const f of PRIORITY_FILES) {
    if (bytes >= MAX_BYTES || seen.size >= MAX_FILES) break;
    await tryFile(f);
  }

  // Sample additional files we haven't already covered. Recurses into
  // directories so a project with src/components/foo.ts gets seen, but
  // bounds depth + skips noisy / heavy directories (node_modules, .git,
  // build outputs) so we don't waste budget on irrelevant files.
  const interestingExt = /\.(md|ts|tsx|js|jsx|py|go|rs|java|rb|toml|yaml|yml)$/i;
  const skipFiles = /package-lock|yarn\.lock|pnpm-lock|\.min\./;
  const skipDirs = new Set([
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    "out",
    "target",
    "venv",
    ".venv",
    "__pycache__",
    ".cache",
  ]);
  const MAX_DEPTH = 3;

  async function walk(
    dir: string,
    prefix: string,
    depth: number,
  ): Promise<void> {
    if (depth > MAX_DEPTH) return;
    if (bytes >= MAX_BYTES || seen.size >= MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Sort so the priority is deterministic (alphabetical) regardless of
    // FS readdir order. Stable cross-platform behavior.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (bytes >= MAX_BYTES || seen.size >= MAX_FILES) return;
      if (ent.name.startsWith(".") && ent.name !== ".env.example") continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        if (skipDirs.has(ent.name)) continue;
        await walk(resolve(dir, ent.name), rel, depth + 1);
      } else if (ent.isFile()) {
        if (!interestingExt.test(ent.name)) continue;
        if (skipFiles.test(ent.name)) continue;
        await tryFile(rel);
      }
    }
  }
  await walk(root, "", 0);

  return out.join("\n").trim();
}

type AnalyzeResponse = {
  summary: string;
  questions: string[];
};

// Strict-ish JSON extraction. Nemotron sometimes wraps JSON in prose or
// markdown code fences; pull the first {...} block we can find and parse
// it. If parsing fails, fall back to a single best-effort summary with
// no questions.
function parseAnalyzeResponse(text: string): AnalyzeResponse {
  const match = text.match(/\{[\s\S]*\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const summary =
        typeof parsed.summary === "string" ? parsed.summary.trim() : "";
      const questions = Array.isArray(parsed.questions)
        ? parsed.questions
            .filter((q: unknown): q is string => typeof q === "string")
            .map((q: string) => q.trim())
            .filter((q: string) => q.length > 0)
        : [];
      if (summary || questions.length > 0) return { summary, questions };
    } catch {
      // fall through to fallback
    }
  }
  return { summary: text.slice(0, 500), questions: [] };
}

export function registerOnboardingRoutes(app: FastifyInstance): void {
  app.post<{ Body: { repo_url: string; token?: string } }>(
    "/onboarding/analyze",
    { schema: { body: ANALYZE_BODY } },
    async (req, reply) => {
      if (!nimConfigured()) {
        return reply.code(503).send({
          error: {
            code: "nim_not_configured",
            message:
              "Set NIM_API_KEY on the agent to enable repo analysis.",
          },
        });
      }

      const { repo_url, token } = req.body;
      const dir = await mkdtemp(join(tmpdir(), "pincer-clone-"));
      try {
        try {
          await gitClone(repo_url, token, dir);
        } catch (err) {
          return reply.code(400).send({
            error: {
              code: "clone_failed",
              message: err instanceof Error ? err.message : String(err),
            },
          });
        }

        const snapshot = await readRepoSnapshot(dir);
        if (snapshot.length === 0) {
          return reply.code(400).send({
            error: {
              code: "empty_repo",
              message:
                "Cloned, but found no readable README / source files.",
            },
          });
        }

        const system = [
          "You are analyzing a software project to help its creator market it.",
          "Read the supplied excerpts and produce two outputs as JSON.",
          "1. summary: a single one-to-two sentence description of what the project does and who it's for.",
          "2. questions: 4 to 6 short clarifying questions that, if answered, would let you draft on-brand replies on Reddit / Hacker News.",
          "Questions should focus on: target audience, key differentiators, what NOT to claim, tone of voice, technical depth to assume.",
          "Return strictly valid JSON, no prose. Example: {\"summary\":\"...\",\"questions\":[\"...\",\"...\"]}",
        ].join(" ");

        let modelText: string;
        try {
          modelText = await chatComplete({
            model: NIM_REPLY_MODEL,
            messages: [
              { role: "system", content: system },
              {
                role: "user",
                content: `Repo URL: ${repo_url}\n\n${snapshot}`,
              },
            ],
            temperature: 0.3,
            max_tokens: 800,
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
        setProjectContext({
          repo_url,
          summary: parsed.summary,
          // Seed qa with empty answers; the next call (/onboarding/answers)
          // overwrites these with what the user actually typed.
          qa: parsed.questions.map((q) => ({ question: q, answer: "" })),
        });
        log.info("onboarding analyze", {
          repoUrl: repo_url,
          summaryChars: parsed.summary.length,
          questions: parsed.questions.length,
        });
        return { summary: parsed.summary, questions: parsed.questions };
      } finally {
        // Always clean up the clone dir, even on success — the cloned
        // repo is no longer useful once we have the summary.
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    },
  );

  app.post<{
    Body: { answers: Array<{ question: string; answer: string }> };
  }>(
    "/onboarding/answers",
    { schema: { body: ANSWERS_BODY } },
    async (req) => {
      const ctx = setProjectContext({ qa: req.body.answers });
      log.info("onboarding answers saved", { count: req.body.answers.length });
      return {
        summary: ctx.summary,
        qa: ctx.qa,
        updated_at: ctx.updated_at,
      };
    },
  );

  // Lightweight read endpoint so the dashboard can show the captured
  // context on the settings page or pre-fill the onboarding form.
  app.get("/onboarding/context", async () => {
    const { repo_url, summary, qa, updated_at } = getProjectContext();
    return { repo_url, summary, qa, updated_at };
  });
}
