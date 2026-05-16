// Single source of truth for runtime configuration. Every knob has an env
// override + a sensible default so the agent boots without any setup on
// a fresh dev machine, but is fully configurable for the Brev VM where
// paths and ports might differ.

import { resolve } from "node:path";

// Port the Fastify HTTP server binds to. Default 8000 to stay clear of the
// Python sidecar (9000) and the Next.js dashboard (3000).
export const PORT = Number(process.env.PORT ?? 8000);

// Interface the server binds to. 127.0.0.1 (loopback only) is the safe dev
// default: no other machine on your network can hit the agent. For a Brev
// deploy, override with HOST=0.0.0.0 so the VM's public port can route to
// it. Outside of Brev's egress sandbox, prefer a private interface +
// bearer-token auth instead of binding 0.0.0.0 in the open.
export const HOST = process.env.HOST ?? "127.0.0.1";

// Where to put the SQLite database file. Relative paths resolve against the
// process's CWD, which for `npm run dev` is the agent/ directory. Use an
// absolute path in production (e.g. /var/lib/pincer/agent.sqlite on Brev).
export const DB_PATH = resolve(process.env.DB_PATH ?? "./agent.sqlite");

// How often the watch loop polls every watched post. Default 60s matches
// PLAN.md and stays well under Reddit's 60-req/min unauth budget at our
// likely volume. Override to something tiny (5000) for local iteration
// when you don't want to wait a full minute between ticks.
export const WATCH_INTERVAL_MS = Number(
  process.env.WATCH_INTERVAL_MS ?? 60_000,
);

// User-Agent header sent on every outbound Reddit / HN request. Reddit's
// API explicitly bans generic UAs like "node-fetch/X" — they 429 on sight.
// A unique, identifiable string (project name + version + contact) gets
// the most generous rate-limit treatment. Override via env when deploying.
export const USER_AGENT =
  process.env.USER_AGENT ??
  "pincer-agent/0.1 (+https://github.com/pincer-app/pincer)";

// CORS allowlist for the dashboard. Permissive on any localhost port so the
// Next dev server can hop ports (3000 → 3001 when 3000 is busy) without
// breaking. In a Brev deploy this needs to be tightened to the laptop's
// origin (or replaced with a bearer-token auth scheme).
export const CORS_ORIGIN_REGEX =
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
