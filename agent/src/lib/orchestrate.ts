// LLM-orchestrator router. Before every "real" chat-completion, a cheap
// orchestrator model decides whether the task warrants the primary
// (strong) or fast (cheap) model, and we route accordingly.
//
// The trade-off, called out so future-you understands the choice:
//   - Pro: when most tasks are simple, we shift them to the fast model.
//   - Con: every call now costs one extra round-trip to the orchestrator.
// Net win depends on how often the router correctly picks `fast` for
// tasks that would otherwise hit `primary`, vs the overhead of the
// router call itself. We log every routing decision so the user can
// audit whether the picker is actually saving anything.
//
// Short-circuits: if primary === fast (user didn't configure distinct
// models), we skip the orchestrator entirely and call the model directly.
// Same shape, zero overhead, no need to special-case at call sites.

import {
  NIM_FAST_MODEL,
  NIM_ORCHESTRATOR_MODEL,
  NIM_PRIMARY_MODEL,
} from "../config.js";
import { chatComplete, NimError, type ChatMessage } from "./nim.js";
import { log } from "./log.js";

export type ModelTier = "primary" | "fast";

export type OrchestratedInput = {
  // One-line description of what the agent is trying to do. The
  // orchestrator sees this verbatim. Examples:
  //   "draft a short reply to a user's comment on Reddit"
  //   "summarize a software project and ask clarifying questions"
  task: string;
  // The messages to send to the chosen model.
  messages: ChatMessage[];
  // Tuning for the chosen model's call. Same shape as nim.ts chatComplete.
  temperature?: number;
  max_tokens?: number;
  // Optional explicit override that bypasses the orchestrator. Used by
  // call sites that already know which tier they need.
  forceTier?: ModelTier;
};

export type OrchestratedResult = {
  text: string;
  model: string;
  tier: ModelTier;
  // Why the orchestrator picked this tier (or "default" if short-circuited).
  reason: string;
};

// Cheap deterministic routing prompt. Asks the orchestrator to classify
// the task and respond with a single-line JSON object so parsing is trivial.
const ROUTER_SYSTEM = [
  "You are a routing controller deciding which model should answer a task.",
  "You have two options:",
  ' - "primary": a strong, expensive model. Use for tasks needing nuanced reasoning, voice/tone control, or multi-paragraph generation (e.g. drafting a reply on behalf of a person, summarizing a codebase).',
  ' - "fast": a cheap, fast model. Use for short classifications, simple yes/no decisions, or tasks where any reasonable answer suffices.',
  "",
  'Return STRICTLY one line of JSON: {"tier": "primary" | "fast", "reason": "<one short phrase>"}',
  "No prose, no code fences. Be decisive.",
].join("\n");

function buildRouterUserPrompt(task: string, messages: ChatMessage[]): string {
  // We hand the orchestrator the task description plus a brief sketch of
  // the input. Caps prevent a giant launch-post body from inflating the
  // orchestrator's input cost (which would defeat the whole point).
  const userMsg = messages.find((m) => m.role === "user");
  const sketch = userMsg ? userMsg.content.slice(0, 600) : "(no user message)";
  return [
    `Task: ${task}`,
    "",
    "Input sketch (first 600 chars):",
    sketch,
  ].join("\n");
}

function parseRouterResponse(text: string): { tier: ModelTier; reason: string } {
  // Tolerant of code fences, leading prose, or just a bare word. Default
  // to primary on any parse confusion — safer to over-spend than to ship
  // a low-quality reply.
  const match = text.match(/\{[\s\S]*?\}/);
  if (match) {
    try {
      const parsed = JSON.parse(match[0]);
      const tier =
        parsed?.tier === "fast" ? "fast" : ("primary" as ModelTier);
      const reason =
        typeof parsed?.reason === "string" ? parsed.reason.trim() : "no reason given";
      return { tier, reason };
    } catch {
      // fall through
    }
  }
  // Bare-word fallback. "fast" tokens win; everything else is primary.
  if (/\bfast\b/i.test(text) && !/\bprimary\b/i.test(text)) {
    return { tier: "fast", reason: "bare-word fast" };
  }
  return { tier: "primary", reason: "router output unparseable" };
}

// Main entry: route → call → return. Throws NimError from the inner call
// if anything fails; orchestrator failures degrade gracefully to primary
// rather than bubbling up, because a routing-step error shouldn't kill a
// drafting task that would otherwise succeed.
export async function orchestratedChatComplete(
  input: OrchestratedInput,
): Promise<OrchestratedResult> {
  const primary = NIM_PRIMARY_MODEL;
  const fast = NIM_FAST_MODEL;

  // Short-circuit when there's nothing to route between.
  if (primary === fast || input.forceTier) {
    const tier = input.forceTier ?? "primary";
    const model = tier === "fast" ? fast : primary;
    const text = await chatComplete({
      model,
      messages: input.messages,
      temperature: input.temperature,
      max_tokens: input.max_tokens,
    });
    return {
      text,
      model,
      tier,
      reason:
        input.forceTier !== undefined
          ? "forced by caller"
          : "primary == fast, orchestrator skipped",
    };
  }

  // Ask the orchestrator. Tiny prompt, tiny output budget. If it errors,
  // log and fall through to primary so the user-visible task still runs.
  let decision: { tier: ModelTier; reason: string } = {
    tier: "primary",
    reason: "router not consulted",
  };
  try {
    const routerOutput = await chatComplete({
      model: NIM_ORCHESTRATOR_MODEL,
      messages: [
        { role: "system", content: ROUTER_SYSTEM },
        {
          role: "user",
          content: buildRouterUserPrompt(input.task, input.messages),
        },
      ],
      temperature: 0.1,
      max_tokens: 60,
    });
    decision = parseRouterResponse(routerOutput);
    log.info("orchestrator routed", {
      task: input.task,
      tier: decision.tier,
      reason: decision.reason,
    });
  } catch (err) {
    log.warn("orchestrator failed, defaulting to primary", {
      task: input.task,
      err:
        err instanceof NimError ? `${err.code}: ${err.message}` : String(err),
    });
  }

  const chosenModel = decision.tier === "fast" ? fast : primary;
  const text = await chatComplete({
    model: chosenModel,
    messages: input.messages,
    temperature: input.temperature,
    max_tokens: input.max_tokens,
  });
  return {
    text,
    model: chosenModel,
    tier: decision.tier,
    reason: decision.reason,
  };
}
