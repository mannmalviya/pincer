// Read/write the singleton project_context row. The reply route reads
// these fields into the LLM prompt so drafted replies stay grounded in
// the user's actual project (not generic "great question!" fluff).

import { getDb } from "../db.js";

export type ProjectQa = { question: string; answer: string };

export type ProjectContext = {
  repo_url: string | null;
  summary: string | null;
  qa: ProjectQa[];
  updated_at: number | null;
};

export function getProjectContext(): ProjectContext {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT repo_url, summary, qa_json, updated_at
         FROM project_context WHERE id = 1`,
    )
    .get() as
    | {
        repo_url: string | null;
        summary: string | null;
        qa_json: string | null;
        updated_at: number;
      }
    | undefined;

  if (row === undefined) {
    return { repo_url: null, summary: null, qa: [], updated_at: null };
  }

  let qa: ProjectQa[] = [];
  if (row.qa_json) {
    try {
      const parsed = JSON.parse(row.qa_json);
      if (Array.isArray(parsed)) {
        qa = parsed.filter(
          (p): p is ProjectQa =>
            typeof p?.question === "string" && typeof p?.answer === "string",
        );
      }
    } catch {
      // Malformed JSON in the DB shouldn't crash callers; treat as empty.
    }
  }

  return {
    repo_url: row.repo_url,
    summary: row.summary,
    qa,
    updated_at: row.updated_at,
  };
}

export function setProjectContext(
  patch: Partial<{
    repo_url: string;
    summary: string;
    qa: ProjectQa[];
  }>,
): ProjectContext {
  const db = getDb();
  // Upsert the singleton row. The CHECK(id=1) constraint guarantees we
  // never accidentally create siblings.
  const current = getProjectContext();
  const next = {
    repo_url: patch.repo_url ?? current.repo_url,
    summary: patch.summary ?? current.summary,
    qa: patch.qa ?? current.qa,
  };
  db.prepare(
    `INSERT INTO project_context(id, repo_url, summary, qa_json, updated_at)
       VALUES(1, ?, ?, ?, unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       repo_url   = excluded.repo_url,
       summary    = excluded.summary,
       qa_json    = excluded.qa_json,
       updated_at = excluded.updated_at`,
  ).run(next.repo_url, next.summary, JSON.stringify(next.qa));
  return getProjectContext();
}

// Format the stored context as a single string suitable for prepending to
// an LLM prompt. Returns null if no context has been captured yet so
// callers can decide whether to skip the section entirely.
export function projectContextForPrompt(): string | null {
  const ctx = getProjectContext();
  const hasAnything =
    (ctx.summary && ctx.summary.length > 0) || ctx.qa.length > 0;
  if (!hasAnything) return null;
  const lines: string[] = ["--- Project context ---"];
  if (ctx.summary) lines.push(`Summary: ${ctx.summary}`);
  for (const { question, answer } of ctx.qa) {
    lines.push(`Q: ${question}`);
    lines.push(`A: ${answer}`);
  }
  return lines.join("\n");
}
