// GET /health — liveness probe. The dashboard calls this before assuming
// the agent is reachable, and PM2 / systemd / Brev launchable health checks
// will hit it on schedule. Stays trivial on purpose: no DB query, no
// platform fetch — just "the HTTP layer is up".

import type { FastifyInstance } from "fastify";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => {
    return { ok: true, service: "pincer-agent", ts: Date.now() };
  });
}
