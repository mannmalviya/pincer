import { loadSidecarEnv } from "./sidecar-env";

// ---------------------------------------------------------------------------
// Thin wrapper around NVIDIA NIM's OpenAI-compatible chat completions API.
//
// We deliberately do NOT use the openai SDK here:
//   - it's a sizable dep for what amounts to one POST endpoint
//   - NIM is OpenAI-compatible on the wire (auth + payload shape), so a
//     bare fetch is enough
//   - we want the API key error to be ours (clear, points to .env), not
//     the SDK's generic "401 Unauthorized"
//
// Server-only — imports `node:fs` indirectly via sidecar-env. Don't call
// from client components.
// ---------------------------------------------------------------------------

export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

// Default Nemotron Super model ID on NIM. The user can override via
// NIM_DRAFT_MODEL in either dashboard/.env.local or the sidecar's .env.
// Falls back to a known-stable Super 49B v1 model that's been on the NIM
// catalog since launch; updating here when NVIDIA bumps the model line.
const DEFAULT_DRAFT_MODEL = "nvidia/llama-3.3-nemotron-super-49b-v1";

// Generous default — Nemotron Super on NIM warms up in 1-3s, then a
// 200-word post rewrite finishes in another 2-5s. 45s gives a comfortable
// upper bound for the cold path without making a hung connection wait
// forever.
const DEFAULT_TIMEOUT_MS = 45_000;

export class NimError extends Error {
  constructor(
    message: string,
    public readonly status?: number,
  ) {
    super(message);
    this.name = "NimError";
  }
}

export async function nimChat(
  messages: ChatMessage[],
  opts: {
    model?: string;
    temperature?: number;
    // When true, asks the model to return strict JSON. Falls back to
    // free-form text if NIM rejects the parameter — Nemotron Super
    // currently honors it but older Nano builds don't.
    jsonMode?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  loadSidecarEnv();

  const apiKey = process.env.NIM_API_KEY;
  if (!apiKey) {
    throw new NimError(
      "NIM_API_KEY is not set. Add it to browser-sidecar/.env or " +
        "dashboard/.env.local. Get a key at https://build.nvidia.com/.",
    );
  }
  // NIM's hosted endpoint. Override via NIM_BASE_URL in env if pointing
  // at a different OpenAI-compatible host (e.g. a local proxy).
  const baseUrl = (
    process.env.NIM_BASE_URL ?? "https://integrate.api.nvidia.com/v1"
  ).replace(/\/$/, "");
  const model = opts.model ?? process.env.NIM_DRAFT_MODEL ?? DEFAULT_DRAFT_MODEL;

  // AbortController stack: caller's signal + our timeout, whichever
  // fires first wins.
  const timeout = new AbortController();
  const handle = setTimeout(() => timeout.abort(), DEFAULT_TIMEOUT_MS);
  const signal = opts.signal
    ? mergeSignals(opts.signal, timeout.signal)
    : timeout.signal;

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: opts.temperature ?? 0.4,
        // response_format is honored by Nemotron Super; ignored harmlessly
        // by models that don't recognize it. We still defensively parse
        // the result rather than trusting JSON mode blindly.
        ...(opts.jsonMode
          ? { response_format: { type: "json_object" } }
          : {}),
      }),
      signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new NimError(
        `NIM returned ${res.status}: ${body.slice(0, 200)}`,
        res.status,
      );
    }
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw new NimError("NIM response did not include message content.");
    }
    return content;
  } catch (err) {
    if (err instanceof NimError) throw err;
    if (err instanceof Error && err.name === "AbortError") {
      throw new NimError("NIM request timed out.");
    }
    throw new NimError(
      err instanceof Error ? err.message : "NIM request failed.",
    );
  } finally {
    clearTimeout(handle);
  }
}

// Compose two AbortSignals. Returns a single signal that aborts when
// either input aborts. There's no native one-liner for this until
// AbortSignal.any() ships everywhere, so a small helper.
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  if (a.aborted) return a;
  if (b.aborted) return b;
  const ctrl = new AbortController();
  const onA = () => ctrl.abort(a.reason);
  const onB = () => ctrl.abort(b.reason);
  a.addEventListener("abort", onA, { once: true });
  b.addEventListener("abort", onB, { once: true });
  return ctrl.signal;
}
