// Fastify factory. Returns a configured app instance that the entrypoint
// (index.ts) can listen on. Separating "build the app" from "listen" makes
// the code testable later (a unit test can `inject()` into the app without
// binding a port).

import cors from "@fastify/cors";
import Fastify, { type FastifyError, type FastifyInstance } from "fastify";

import { CORS_ORIGIN_REGEX } from "./config.js";
import { log } from "./lib/log.js";
import { registerBackfillUserRoute } from "./routes/backfill-user.js";
import { registerCommentsRoute } from "./routes/comments.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerGithubIntegrationRoutes } from "./routes/integrations.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerPostsRoutes } from "./routes/posts.js";
import { registerReplyRoute } from "./routes/reply.js";
import { registerSettingsRoute } from "./routes/settings.js";
import { registerStatsRoute } from "./routes/stats.js";

export async function buildServer(): Promise<FastifyInstance> {
  // logger: false because we've got our own logger in lib/log.ts. Fastify's
  // default pino output is fine, but the agent's logs already include
  // tick-level info; doubling them up would be noise.
  const app = Fastify({ logger: false });

  // CORS: allow any localhost / 127.0.0.1 port on http or https. The
  // dashboard runs on :3000 by default but Next will hop to :3001 if 3000
  // is busy, so we match by regex rather than enumerating. This is the
  // same shape the Python sidecar uses.
  await app.register(cors, {
    origin: CORS_ORIGIN_REGEX,
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  });

  // Uniform error responses. Without this, validation errors come back as
  // Fastify's default `{ statusCode, error, message }` shape, but our
  // hand-written handlers return `{ error: { code, message } }` — better
  // to converge on one envelope.
  app.setErrorHandler((err: FastifyError, _req, reply) => {
    const status = err.statusCode ?? 500;
    log.error("request failed", {
      status,
      code: err.code,
      message: err.message,
    });
    reply.code(status).send({
      error: {
        code: err.code ?? (status === 500 ? "internal" : "bad_request"),
        message: err.message,
      },
    });
  });

  // Register every route group. Order doesn't matter functionally — Fastify
  // builds a single radix tree from all registrations.
  registerHealthRoute(app);
  registerPostsRoutes(app);
  registerStatsRoute(app);
  registerBackfillUserRoute(app);
  registerCommentsRoute(app);
  registerSettingsRoute(app);
  registerReplyRoute(app);
  registerOnboardingRoutes(app);
  registerGithubIntegrationRoutes(app);

  return app;
}
