// Tiny structured logger. Avoids pulling in pino/winston; we have ~3 log
// sites and don't need transports or rotation. Logs go to stdout/stderr
// where PM2 / systemd / Brev's launchable logging can scoop them up.
//
// Format: `<level> [<ms>] <message> {<json-context>}`
// The trailing JSON is omitted when no context is passed.

type Level = "info" | "warn" | "error";

function ts(): string {
  return new Date().toISOString();
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  const head = `${level.toUpperCase()} [${ts()}] ${msg}`;
  const tail = ctx && Object.keys(ctx).length ? ` ${JSON.stringify(ctx)}` : "";
  const line = head + tail;
  // Errors and warnings to stderr so log aggregators can separate them from
  // ordinary info. Info goes to stdout.
  if (level === "error" || level === "warn") {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    emit("error", msg, ctx),
};
