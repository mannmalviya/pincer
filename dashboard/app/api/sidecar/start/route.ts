/**
 * POST /api/sidecar/start
 *
 * Idempotent boot for the Python browser-sidecar that the onboarding flow
 * (and runtime posting) both depend on. Behaviour:
 *
 *   1. Probe http://localhost:9000/health. If it responds OK, the sidecar is
 *      already running (started manually, or by a prior call to this route).
 *      Return immediately.
 *   2. Otherwise spawn `uv run uvicorn app:app --port 9000` as a child of the
 *      Next.js dev server, with stdio inherited so the sidecar's logs appear
 *      in the same terminal as `npm run dev`.
 *   3. Poll /health for up to 15s. Uvicorn + Playwright import takes 2-4s
 *      cold, so the wait is generous but bounded.
 *
 * Concurrent requests dedupe to a single spawn attempt via a module-level
 * promise — opening multiple wizard tabs at once won't pile up uvicorns.
 *
 * Process lifetime: the spawned uvicorn is NOT detached, so it dies when
 * the dev server dies (good — no orphans). Next dev's HMR usually doesn't
 * restart the Node process, so the child survives most reloads.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const SIDECAR_URL = "http://localhost:9000";

// Shared promise so concurrent /api/sidecar/start calls await the same
// spawn instead of each launching their own uvicorn.
let starting: Promise<boolean> | null = null;

// 500ms is enough for a local fetch to either succeed or fail cleanly.
// Any slower and the sidecar is in trouble.
async function isAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${SIDECAR_URL}/health`, {
      signal: AbortSignal.timeout(500),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// Polls /health every 250ms until it answers OK or we hit the timeout.
async function waitForAlive(timeoutMs: number): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isAlive()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function doStart(): Promise<boolean> {
  // We expect `npm run dev` to be invoked from `dashboard/`, which sets
  // process.cwd() to `<repo>/dashboard`. The sibling sidecar is `../browser-sidecar`.
  const sidecarDir = resolve(process.cwd(), "..", "browser-sidecar");

  // Sanity check the path resolves to a real sidecar directory. If the user
  // ran the dashboard from a non-standard cwd, catch the mistake here with
  // a clear error instead of a cryptic "command failed: uv not found".
  if (!existsSync(resolve(sidecarDir, "app.py"))) {
    console.error(
      `[sidecar/start] expected sidecar at ${sidecarDir} but app.py not found. ` +
        "Run `npm run dev` from the dashboard/ directory.",
    );
    return false;
  }

  console.log(`[sidecar/start] spawning uvicorn in ${sidecarDir}`);
  const child = spawn("uv", ["run", "uvicorn", "app:app", "--port", "9000"], {
    cwd: sidecarDir,
    // Pipe child's stdio to the Next dev terminal so the user can see
    // playwright errors etc. alongside their Next logs.
    stdio: "inherit",
  });

  child.on("error", (err) => {
    console.error("[sidecar/start] failed to spawn uvicorn:", err);
  });
  child.on("exit", (code, signal) => {
    console.log(`[sidecar/start] uvicorn exited (code=${code}, signal=${signal})`);
  });

  return waitForAlive(15_000);
}

export async function POST() {
  // Fast path: already running, nothing to do.
  if (await isAlive()) {
    return Response.json({ ok: true, status: "already-running" });
  }

  // Lazy-create the dedupe promise. Subsequent concurrent calls await
  // the same one. We clear it once the attempt finishes so a later
  // request gets a fresh try if this one failed.
  if (starting === null) {
    starting = doStart().finally(() => {
      // setImmediate puts the clear at the back of the event loop so any
      // currently-awaiting callers resolve off this promise first.
      setImmediate(() => {
        starting = null;
      });
    });
  }

  const ok = await starting;
  if (!ok) {
    return Response.json(
      {
        ok: false,
        error:
          "Couldn't start the browser sidecar. Check that `uv` is installed " +
          "and dependencies are synced (`uv sync` from browser-sidecar/).",
      },
      { status: 500 },
    );
  }

  return Response.json({ ok: true, status: "started" });
}
