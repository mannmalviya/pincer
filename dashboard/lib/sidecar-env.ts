import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Read the sidecar's .env into process.env so the dashboard can use the
// NIM_API_KEY / NIM_BASE_URL / NIM_MODEL keys already configured there,
// without forcing the user to duplicate them in dashboard/.env.local.
//
// Why this exists: Next.js only auto-loads env files from its own project
// root, so the browser-sidecar/.env that already holds the NVIDIA key is
// invisible to the dashboard. Rather than ask the user to maintain two
// .env files (and re-paste the key into both), we read the sidecar's
// .env at module init and back-fill process.env entries that aren't
// already defined. Anything the user sets in dashboard/.env.local wins
// over what's in the sidecar's file.
//
// Server-only: imports `node:fs`, so route handlers and other
// server-side code may use it, but not anything that runs in the browser.
// ---------------------------------------------------------------------------

// Tiny `.env` parser. Handles KEY=value, ignores blank lines and #-comments,
// strips surrounding single/double quotes on the value, and collapses
// escaped-newline sequences inside double-quoted strings. Doesn't try to
// be a full POSIX shell — the sidecar's .env is plain KEY=value today.
function parseEnv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    // Inline `# comment` after an unquoted value gets stripped.
    if (!value.startsWith('"') && !value.startsWith("'")) {
      const hash = value.indexOf(" #");
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
      // Only expand \n inside double-quoted values, matching bash semantics.
      if (rawLine.includes('"')) value = value.replace(/\\n/g, "\n");
    }
    out[key] = value;
  }
  return out;
}

// Memoize so concurrent first-imports share one disk read. Initial load
// happens on first call (not at module load) so a missing sidecar .env
// during a build doesn't break compilation.
let loaded = false;

export function loadSidecarEnv(): void {
  if (loaded) return;
  loaded = true;

  // process.cwd() for `next dev` is the dashboard directory. Sidecar lives
  // at the sibling path. We don't fail if the file is missing — the
  // dashboard may legitimately be running without the sidecar present
  // (e.g. for UI development), and the route handlers that actually need
  // NIM_API_KEY will surface their own clear error.
  const path = resolve(process.cwd(), "..", "browser-sidecar", ".env");
  let contents: string;
  try {
    contents = readFileSync(path, "utf8");
  } catch {
    return;
  }

  for (const [k, v] of Object.entries(parseEnv(contents))) {
    // Don't overwrite — dashboard/.env.local and shell-exported vars take
    // precedence over the sidecar's file.
    if (process.env[k] === undefined) {
      process.env[k] = v;
    }
  }
}
