/**
 * POST /api/llm/edit
 *
 * Conversational post editor backed by NVIDIA NIM (Nemotron Super).
 *
 * Body:
 *   {
 *     messages: { role: "user" | "assistant", content: string }[],
 *     body:     string,           // current draft body the user is editing
 *     title?:   string,           // optional post title for additional context
 *     platform?:"reddit" | "hn",  // optional platform hint for tone guidance
 *   }
 *
 * Response (200):
 *   {
 *     reply:     string,          // assistant's chat reply
 *     newBody?:  string,          // present iff the model rewrote the body
 *     newTitle?: string,          // present iff the model rewrote the title
 *   }
 *
 * Response (4xx/5xx):
 *   { error: string }
 *
 * Why JSON-mode + sentinel parsing: we ask Nemotron Super to emit
 * `{"reply": "...", "new_body": "..."}`. If the model ignores JSON mode
 * (older or non-Super models do), we fall back to treating the whole
 * response as the chat reply with no edit. Safer than parsing free text
 * for code blocks.
 */
import { NextResponse } from "next/server";

import { nimChat, NimError, type ChatMessage } from "@/lib/nim";

// Cap inputs to keep prompts bounded and prevent abuse if someone pipes
// a huge file into the request. These limits are generous for actual
// social-media posts (Reddit allows 40k chars in self-text, HN is much
// shorter) so they only bite on degenerate input.
const MAX_BODY_CHARS = 8_000;
const MAX_TITLE_CHARS = 400;
const MAX_MESSAGES = 30;

type ClientMessage = { role: "user" | "assistant"; content: string };

type ChatRequest = {
  messages: ClientMessage[];
  body: string;
  title?: string;
  platform?: "reddit" | "hn";
};

// System prompt: anchors the conversation, embeds the current body so
// the model can reason about edits in context, and pins the JSON output
// contract. The contract is permissive — `new_body` is optional — so the
// model can have a normal chat turn without forcing an edit.
function buildSystemPrompt(req: ChatRequest): string {
  // Per-platform tone + formatting constraints. Reddit publishes via
  // the sidecar's markdown-mode composer (see browser-sidecar/platforms/
  // reddit.py — it toggles the composer into markdown mode before
  // filling), so full markdown is fine. HN renders no markdown.
  const platformLine =
    req.platform === "reddit"
      ? [
          "The target platform is Reddit. Match Reddit conventions: conversational, useful, no overt marketing language.",
          "FORMATTING: full markdown is supported and rendered. Use **bold**, *italics*, headings (#, ##, ###), bullet/numbered lists, blockquotes (>), code blocks (```), inline code (`...`), and links ([text](url)) when they actually help structure the post. Don't over-format — Reddit posts read best when most lines are prose.",
        ].join("\n")
      : req.platform === "hn"
        ? [
            "The target platform is Hacker News. Match HN conventions: factual, technical, no hype, no emoji.",
            "FORMATTING: HN renders no markdown at all. Use plain prose with paragraph breaks (blank lines between paragraphs). Do NOT use any markdown syntax (no **bold**, no *italics*, no headings, no lists, no code fences). For links, write the bare URL.",
          ].join("\n")
        : "The target platform is not specified; default to a clean, conversational tone.";

  return [
    "You are an editor helping the user refine a social-media post.",
    "",
    "How you reply:",
    'You MUST respond with a single JSON object: {"reply": "...", "new_title": "...", "new_body": "..."}',
    '- "reply" (required): your conversational response to the user.',
    '- "new_title" (optional): if you are proposing a new headline for the post, the FULL new title. Omit if the title should stay as-is.',
    '- "new_body" (optional): if you are proposing an edit to the post body, the FULL new body text. Omit if the body should stay as-is.',
    "You may include new_title without new_body (and vice versa). If you are just chatting (asking a clarifying question, giving feedback without changes, etc.), omit both.",
    "When proposing an edit, return the complete new title/body, NOT a diff or fragment. The dashboard computes the diff itself.",
    "Do not wrap the JSON in markdown code fences.",
    "",
    platformLine,
    "",
    req.title ? `Current post title: ${req.title.slice(0, MAX_TITLE_CHARS)}` : "",
    "",
    "Current post body (between <<< and >>>):",
    "<<<",
    req.body.slice(0, MAX_BODY_CHARS),
    ">>>",
  ]
    .filter(Boolean)
    .join("\n");
}

// Parse the model's response into {reply, newBody?, newTitle?}. Tolerant:
// if the model returned plain text (ignored JSON mode), we treat the
// whole thing as the chat reply with no edit. Best-effort `JSON.parse`
// first, then a regex extraction of the outermost `{...}` block in case
// the model wrapped its JSON in stray prose.
function parseAssistantResponse(raw: string): {
  reply: string;
  newBody?: string;
  newTitle?: string;
} {
  const tryJson = (text: string) => {
    try {
      const parsed = JSON.parse(text) as {
        reply?: unknown;
        new_body?: unknown;
        new_title?: unknown;
      };
      if (typeof parsed.reply === "string") {
        const out: { reply: string; newBody?: string; newTitle?: string } = {
          reply: parsed.reply,
        };
        if (typeof parsed.new_body === "string") {
          out.newBody = parsed.new_body;
        }
        if (typeof parsed.new_title === "string") {
          out.newTitle = parsed.new_title;
        }
        return out;
      }
    } catch {
      // fall through
    }
    return null;
  };

  // First try the raw string.
  const direct = tryJson(raw.trim());
  if (direct) return direct;

  // Then extract the outermost {...}. The lazy match in JSON-with-prose
  // breaks for objects containing nested braces, so we walk balanced
  // braces ourselves. Cheap; the response is small.
  const start = raw.indexOf("{");
  if (start !== -1) {
    let depth = 0;
    for (let i = start; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) {
          const candidate = raw.slice(start, i + 1);
          const fromBlock = tryJson(candidate);
          if (fromBlock) return fromBlock;
          break;
        }
      }
    }
  }

  // Model didn't give us JSON. Treat the whole reply as chat, no edit.
  return { reply: raw.trim() };
}

export async function POST(req: Request) {
  let body: ChatRequest;
  try {
    body = (await req.json()) as ChatRequest;
  } catch {
    return NextResponse.json(
      { error: "Body must be valid JSON." },
      { status: 400 },
    );
  }

  // Lightweight validation. Bad input gets a clear 400 instead of a
  // confusing NIM error downstream.
  if (
    !Array.isArray(body.messages) ||
    body.messages.length === 0 ||
    body.messages.length > MAX_MESSAGES ||
    typeof body.body !== "string"
  ) {
    return NextResponse.json(
      {
        error:
          "Request must include a `body` string and a non-empty `messages` array " +
          `(max ${MAX_MESSAGES} turns).`,
      },
      { status: 400 },
    );
  }

  // Build the full message list: system prompt + the client's chat
  // history (filtered to only user/assistant + truncated to safe sizes).
  const fullMessages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(body) },
    ...body.messages
      .filter(
        (m): m is ClientMessage =>
          (m?.role === "user" || m?.role === "assistant") &&
          typeof m?.content === "string",
      )
      .map((m) => ({
        role: m.role,
        // Clip each turn so a runaway log can't blow the prompt.
        content: m.content.slice(0, MAX_BODY_CHARS),
      })),
  ];

  let raw: string;
  try {
    raw = await nimChat(fullMessages, { jsonMode: true, temperature: 0.5 });
  } catch (err) {
    const message =
      err instanceof NimError
        ? err.message
        : err instanceof Error
          ? err.message
          : "Unknown error talking to NIM.";
    return NextResponse.json({ error: message }, { status: 502 });
  }

  const parsed = parseAssistantResponse(raw);
  return NextResponse.json(parsed);
}
