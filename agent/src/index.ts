// Entry point. Runs three steps in order:
//
//   1. Initialise the SQLite handle (which also runs schema.sql).
//   2. Build and bind the Fastify server on PORT.
//   3. Start the watch loop so polling kicks off immediately.
//
// SIGINT/SIGTERM are wired to a clean shutdown that closes the DB (so the
// WAL checkpoints flush) and stops the watch loop's timer. PM2 sends
// SIGINT on `pm2 stop`; Brev's launchable lifecycle uses SIGTERM. Both
// land in the same shutdown path.

// Load .env BEFORE any other import that reads process.env. config.ts
// evaluates its module-level `process.env.X` accesses at import time, so
// dotenv has to run first or those reads see undefined. A missing .env
// is not an error — process.env still applies, so a fully PM2- or
// systemd-driven deploy keeps working.
import "dotenv/config";

import { HOST, PORT } from "./config.js";
import { closeDb, getDb } from "./db.js";
import { log } from "./lib/log.js";
import { buildServer } from "./server.js";
import { startWatchLoop, stopWatchLoop } from "./watch/loop.js";

async function main(): Promise<void> {
  // Touch the DB once at startup so the schema migration happens before
  // any HTTP request can land. Without this, the first concurrent burst
  // of requests would all try to migrate.
  getDb();

  const app = await buildServer();
  await app.listen({ port: PORT, host: HOST });
  log.info("agent listening", { port: PORT, host: HOST });

  // Start polling after the server is up. The first tick fires
  // immediately (defined in loop.ts), seeding any rows that survived a
  // previous boot.
  startWatchLoop();

  // Graceful shutdown — close in reverse order of startup so in-flight
  // ticks finish before the DB closes under them.
  const shutdown = async (signal: string) => {
    log.info("shutdown signal received", { signal });
    stopWatchLoop();
    try {
      await app.close();
    } catch (err) {
      log.warn("server close errored", {
        err: err instanceof Error ? err.message : String(err),
      });
    }
    closeDb();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err: unknown) => {
  log.error("startup failed", {
    err: err instanceof Error ? err.stack ?? err.message : String(err),
  });
  process.exit(1);
});
