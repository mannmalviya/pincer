// GitHub OAuth token storage. Backed by the existing settings k/v table so
// we don't need a schema change. Single-user demo: one row in `settings`
// with key `github_access_token` holds the most recently connected token.
//
// The token is stored as a plain string (not encrypted at rest). For a
// hackathon demo on a single-user SQLite file this is acceptable; for a
// production multi-user product the right move is a per-user encrypted
// blob, but that's out of scope here.

import { getDb } from "../db.js";

const KEY = "github_access_token";

// Returns the stored GitHub OAuth access token, or null if the user
// hasn't connected GitHub yet. Read fresh on every call so a disconnect
// from the dashboard takes effect immediately without restarting the
// agent.
export function getGithubToken(): string | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT value FROM settings WHERE key = ?`)
    .get(KEY) as { value: string } | undefined;
  if (!row || row.value.length === 0) return null;
  return row.value;
}

// Persist a token. Called by POST /integrations/github/connect after the
// Next.js OAuth callback exchanges the code for an access token. Uses
// UPSERT so reconnecting (e.g. after revoke) overwrites rather than
// erroring on the PK collision.
export function setGithubToken(token: string): void {
  const db = getDb();
  db.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(KEY, token);
}

// Remove the stored token. Called by POST /integrations/github/disconnect.
// We don't try to revoke the token with GitHub here; revocation is a
// separate user action on github.com (Settings -> Applications). Locally
// forgetting the token is enough to stop the agent from using it.
export function clearGithubToken(): void {
  const db = getDb();
  db.prepare(`DELETE FROM settings WHERE key = ?`).run(KEY);
}

// True if a token is currently stored. Cheaper than getGithubToken when
// the caller only needs a boolean (e.g. the /integrations/github/status
// endpoint).
export function hasGithubToken(): boolean {
  return getGithubToken() !== null;
}
