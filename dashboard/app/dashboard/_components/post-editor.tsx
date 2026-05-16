"use client";

import { diffLines } from "diff";
import { useEffect, useMemo, useRef, useState } from "react";
import { FaArrowUp, FaCheck, FaXmark, FaStop } from "react-icons/fa6";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

// Shared fixed height for all three body-area variants: textarea, diff
// review, and chat panel. Keeping these in lockstep prevents the page
// from reflowing when the user toggles between editing and reviewing,
// which was the proximate cause of the "page scrolls to top on enter"
// bug — once the chat-end ref called scrollIntoView, the document
// jumped because the panel had grown taller than the viewport.
const EDITOR_HEIGHT_CLASS = "h-[520px]";

// ---------------------------------------------------------------------------
// PostEditor — LLM-assisted post body editor.
//
// Layout (two-column on >=md, stacked on mobile):
//   Left  : the post body. Normally a textarea; switches to a per-hunk
//           diff review when the model proposes an edit.
//   Right : chat panel for talking to Nemotron Super through
//           /api/llm/edit. Each assistant turn may include a proposed new
//           body, which the dashboard diffs against the current text and
//           presents as hunks the user can accept or reject individually.
//
// Owned state:
//   - chat messages (local; not persisted across reloads)
//   - in-flight request status
//   - pending proposal + per-hunk accept/reject state
//
// Owner-of-truth state (passed in via props):
//   - body text (so the parent's Publish flow has the final string)
//
// When the user applies a proposal, we compute the merged body from
// accepted hunks and bubble it up via onBodyChange.
// ---------------------------------------------------------------------------

type ChatMessage = {
  // Stable id so React can keep messages in place even as the list grows.
  // Doesn't go to the server — the API doesn't need it.
  id: string;
  role: "user" | "assistant";
  content: string;
  // Marks an assistant turn that came with a proposed edit. Used to
  // gray out the message slightly after the proposal is resolved.
  hadProposal?: boolean;
};

// Diff representation. Either an unchanged chunk (context) or a hunk
// the user must decide on. The walk that builds these collapses each
// consecutive run of added/removed jsdiff parts into one hunk.
type DiffPart =
  | { kind: "unchanged"; value: string }
  | {
      kind: "hunk";
      id: string;
      removed: string;
      added: string;
      status: "pending" | "accepted" | "rejected";
    };

type Proposal = {
  // The model's full new body. We keep it around so the user can re-
  // generate hunks (e.g. if they want a re-walk after editing one) or
  // bail out of the review entirely.
  proposedBody: string;
  parts: DiffPart[];
};

export function PostEditor({
  body,
  onBodyChange,
  title,
  platform,
}: {
  body: string;
  onBodyChange: (next: string) => void;
  title: string;
  // Optional platform hint, forwarded to the server so the system prompt
  // can nudge the model toward the right tone. Reddit / HN today.
  platform?: "reddit" | "hn";
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);

  // Whether the left pane is showing the rendered-markdown preview
  // instead of the textarea. Auto-flips off whenever a new generation
  // starts (or a proposal arrives), so the user is always looking at
  // editable content when something is about to change.
  const [previewing, setPreviewing] = useState(false);

  // Holds the in-flight request's AbortController so the stop button
  // (Claude-style square that replaces the arrow while generating) can
  // cancel a slow NIM call. Stored in a ref because we never want a
  // state update to fire just to track the controller's identity.
  const abortRef = useRef<AbortController | null>(null);

  // Scroll the chat to the bottom whenever a new message lands. We write
  // scrollTop on the messages container directly — Element.scrollIntoView
  // bubbles up through scrollable ancestors and can pull the whole document
  // along, which produces an unwanted "page jumps to top on Enter" effect
  // once the editor section itself becomes taller than the viewport.
  const messagesRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = messagesRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages, sending]);

  async function sendMessage() {
    const text = input.trim();
    if (!text || sending) return;

    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
    };
    setMessages((cur) => [...cur, userMessage]);
    setInput("");
    setSending(true);
    setError(null);
    // Drop out of preview mode the moment a new generation begins —
    // the body is about to change (or the user is about to see a diff),
    // and the editable surface is the right place to land.
    setPreviewing(false);

    // Fresh AbortController per request — the stop button calls .abort()
    // on this if the user wants to cancel a slow generation.
    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/llm/edit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // The server adds the system prompt; we just pass user/assistant turns.
          messages: [...messages, userMessage].map((m) => ({
            role: m.role,
            content: m.content,
          })),
          body,
          title,
          platform,
        }),
        signal: controller.signal,
      });
      const data = (await res.json()) as {
        reply?: string;
        newBody?: string;
        error?: string;
      };
      if (!res.ok || !data.reply) {
        setError(data.error ?? "The model didn't return a reply.");
        return;
      }

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.reply,
        hadProposal: typeof data.newBody === "string",
      };
      setMessages((cur) => [...cur, assistantMessage]);

      // If the model proposed an edit, compute the diff hunks and switch
      // the left column to review mode. We only allow one in-flight
      // proposal at a time — applying or canceling resets it.
      if (typeof data.newBody === "string" && data.newBody !== body) {
        setProposal({
          proposedBody: data.newBody,
          parts: buildDiffParts(body, data.newBody),
        });
      }
    } catch (err) {
      // User-initiated cancel is not an error worth surfacing — just
      // stop the spinner. The fetch promise rejects with an AbortError
      // when controller.abort() fires.
      if (err instanceof DOMException && err.name === "AbortError") {
        // no-op
      } else {
        setError(
          err instanceof Error
            ? err.message
            : "Network error talking to /api/llm/edit.",
        );
      }
    } finally {
      setSending(false);
      abortRef.current = null;
    }
  }

  // Stop button handler. Aborts the in-flight fetch; the catch above
  // swallows the AbortError and the finally clears state.
  function stopGeneration() {
    abortRef.current?.abort();
  }

  function setHunkStatus(
    hunkId: string,
    status: "accepted" | "rejected",
  ): void {
    if (!proposal) return;
    setProposal({
      proposedBody: proposal.proposedBody,
      parts: proposal.parts.map((p) =>
        p.kind === "hunk" && p.id === hunkId ? { ...p, status } : p,
      ),
    });
  }

  // All hunks must be decided (accepted or rejected) before the merged
  // body can be applied. A proposal with zero hunks (model returned the
  // same body) couldn't have been created — we guard above — so this
  // can only be false while at least one hunk is still "pending".
  const allResolved =
    proposal !== null &&
    proposal.parts.every((p) => p.kind !== "hunk" || p.status !== "pending");

  function applyProposal() {
    if (!proposal || !allResolved) return;
    const merged = mergeParts(proposal.parts);
    onBodyChange(merged);
    setProposal(null);
  }

  // Auto-apply when every hunk has been resolved. The per-hunk ✓/✗
  // buttons are now the only controls in the diff view — there's no
  // separate Apply step the user has to remember to press. Rejecting
  // all hunks doubles as "discard the proposal" since the merged body
  // is just the original.
  useEffect(() => {
    if (proposal && allResolved) {
      applyProposal();
    }
    // applyProposal is stable enough for this — react-hooks/exhaustive-deps
    // would want it memoized, but inlining it would obscure the intent.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [proposal, allResolved]);

  return (
    <div className="grid grid-cols-1 md:grid-cols-[1fr_320px] gap-6">
      {/* Left column: textarea / diff review / preview. All three
          variants use the same fixed height (EDITOR_HEIGHT_CLASS) so
          the page layout doesn't reflow when toggling between them. */}
      <div className="flex flex-col gap-2">
        <div className="flex items-end justify-between">
          <Label htmlFor="post-body">Body</Label>
          {/* Preview toggle. Hidden while a proposal is being reviewed
              — the diff view is the right surface there, and preview
              would just hide the changes the user needs to see. */}
          {!proposal && (
            <button
              type="button"
              onClick={() => setPreviewing((p) => !p)}
              className={
                "text-xs font-medium rounded-full px-3 h-7 border transition-colors " +
                (previewing
                  ? "border-[color:var(--brand)] bg-[color:var(--brand)]/10 text-[color:var(--brand)]"
                  : "border-foreground/15 text-foreground/70 hover:border-foreground/30 hover:bg-foreground/5")
              }
            >
              {previewing ? "Edit" : "Preview"}
            </button>
          )}
        </div>
        {proposal ? (
          <DiffReview
            parts={proposal.parts}
            onHunkDecision={setHunkStatus}
          />
        ) : previewing ? (
          <PostPreview body={body} />
        ) : (
          <LinedTextarea
            id="post-body"
            value={body}
            onChange={onBodyChange}
            placeholder="Write your post here. Markdown works on Reddit and HN."
          />
        )}
      </div>

      {/* Right column: chat panel. Fixed height matches the body editor
          so toggling between textarea and diff review never reflows the
          page and the messages scroll inside their own container. */}
      <div
        className={
          "flex flex-col rounded-lg border border-foreground/10 bg-foreground/[0.02] " +
          EDITOR_HEIGHT_CLASS
        }
      >
        <header className="px-3 py-2 border-b border-foreground/10 flex items-center justify-between">
          <span className="text-xs font-mono uppercase tracking-wider text-foreground/50">
            Editor chat
          </span>
          <span className="text-[10px] font-mono text-foreground/40">
            nemotron super
          </span>
        </header>

        <div
          ref={messagesRef}
          className="flex-1 overflow-y-auto px-3 py-3 flex flex-col gap-2 text-sm"
        >
          {messages.length === 0 && !sending && (
            <p className="text-foreground/50 text-xs leading-relaxed">
              Ask for an edit (&ldquo;tighten the intro&rdquo;, &ldquo;add a
              question at the end&rdquo;) or just chat about the post. The
              model can propose changes that you accept hunk by hunk in the
              left pane.
            </p>
          )}
          {messages.map((m) => (
            <ChatBubble key={m.id} message={m} />
          ))}
          {sending && (
            // Shimmer-text utility lives in globals.css. Don't add a
            // Tailwind text-color class here — the utility relies on
            // color: transparent + background-clip:text to mask its
            // gradient, and a competing text-* class would either fight
            // the transparency or override the gradient with a flat fill.
            <div className="text-xs italic shimmer-text">Thinking...</div>
          )}
          {error && (
            <div className="text-xs text-red-600 dark:text-red-400 leading-relaxed">
              {error}
            </div>
          )}
        </div>

        <div className="border-t border-foreground/10 p-2 flex gap-2 items-end">
          <AutoGrowTextarea
            value={input}
            onChange={setInput}
            onSubmit={sendMessage}
            disabled={sending}
            placeholder="Ask the model..."
          />
          {/* Claude-Code-style send/stop affordance.
              Two visual states:
                - idle: brand-orange filled circle, white up-arrow
                - generating: white filled circle, black square (stop)
              Both share the same w/h so the layout doesn't twitch when
              the model starts responding. While generating, the button
              stays clickable so the user can cancel the in-flight
              request via AbortController. */}
          {sending ? (
            <Button
              size="icon"
              onClick={stopGeneration}
              aria-label="Stop generating"
              className={
                "h-9 w-9 shrink-0 rounded-full " +
                "bg-white text-black border border-foreground/15 " +
                "hover:bg-foreground/5"
              }
            >
              <FaStop className="text-xs" />
            </Button>
          ) : (
            <Button
              size="icon"
              onClick={sendMessage}
              disabled={!input.trim()}
              aria-label="Send"
              className={
                "h-9 w-9 shrink-0 rounded-full " +
                "bg-[color:var(--brand)] text-white " +
                "hover:bg-[color:var(--brand)]/90 " +
                "disabled:bg-[color:var(--brand)]/40 disabled:text-white"
              }
            >
              <FaArrowUp className="text-sm" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Chat bubble — one message in the chat panel.
//
// User messages render as plain text (they only ever contain the user's
// typed input, so markdown rendering would be unexpected). Assistant
// messages render through react-markdown so the model's standard
// formatting — bold, italics, bullet lists, numbered lists, inline code,
// links — comes through as styled markup rather than literal asterisks
// and pound signs.
// ---------------------------------------------------------------------------
function ChatBubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div
      className={
        "rounded-lg px-3 py-2 max-w-[90%] break-words " +
        (isUser
          ? "bg-foreground text-background self-end whitespace-pre-wrap"
          : "bg-background border border-foreground/10 self-start")
      }
    >
      {isUser ? message.content : <AssistantMarkdown text={message.content} />}
      {message.hadProposal && !isUser && (
        <div className="mt-1 text-[10px] font-mono uppercase tracking-wider text-foreground/40">
          proposed an edit →
        </div>
      )}
    </div>
  );
}

// Markdown renderer for assistant chat bubbles. We provide explicit
// component overrides rather than installing @tailwindcss/typography
// because the chat bubble is small and dense — most prose defaults
// (large headings, generous vertical rhythm) are wrong here. Each
// override is a tight Tailwind-styled element matching the bubble's
// font size and color tokens.
function AssistantMarkdown({ text }: { text: string }) {
  return (
    <div className="text-sm leading-relaxed flex flex-col gap-2">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // Paragraphs flow with the gap-2 above; no extra margin to
          // avoid double spacing.
          p: ({ children }) => <p>{children}</p>,
          // Lists: tight bullets/numbers. The wrapper gap on the parent
          // separates lists from neighboring paragraphs.
          ul: ({ children }) => (
            <ul className="list-disc pl-5 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-5 space-y-1">{children}</ol>
          ),
          // Inline code gets a tinted chip; code blocks get the same
          // treatment as a multiline block since we don't pull in a
          // full syntax highlighter for chat.
          code: ({ children, className }) => {
            const isBlock = /language-/.test(className ?? "");
            return isBlock ? (
              <pre className="bg-foreground/[0.06] rounded p-2 overflow-x-auto text-xs font-mono leading-relaxed">
                <code>{children}</code>
              </pre>
            ) : (
              <code className="bg-foreground/[0.06] rounded px-1 py-0.5 text-[0.85em] font-mono">
                {children}
              </code>
            );
          },
          // Force links to open in a new tab; they almost always point
          // at docs or external references in this context.
          a: ({ children, href }) => (
            <a
              href={href}
              target="_blank"
              rel="noreferrer"
              className="text-[color:var(--brand)] underline hover:no-underline"
            >
              {children}
            </a>
          ),
          // Tame headings inside a chat bubble — render them as
          // emphasized text rather than display-sized type.
          h1: ({ children }) => (
            <p className="font-semibold text-base">{children}</p>
          ),
          h2: ({ children }) => (
            <p className="font-semibold text-sm">{children}</p>
          ),
          h3: ({ children }) => (
            <p className="font-semibold text-sm">{children}</p>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

// ---------------------------------------------------------------------------
// DiffReview — per-hunk accept/reject UI with a line-number gutter that
// mirrors the body editor's layout.
//
// We flatten the diff parts into a per-line row list so each line gets a
// gutter cell, matching the editor's visual structure. Each row is one of:
//   - context : kept from the original, plain text
//   - removed : marked for deletion, red tint
//   - added   : new content, green tint
//   - controls: per-hunk Accept/Reject button row (no gutter number)
//
// Line numbers in the gutter follow the original-body numbering: context
// and removed lines show their position in the body BEFORE the proposed
// edit; added lines show a `+` since they wouldn't exist there. This is
// the same convention `git diff` uses for the left side of a unified diff.
// ---------------------------------------------------------------------------
function DiffReview({
  parts,
  onHunkDecision,
}: {
  parts: DiffPart[];
  onHunkDecision: (id: string, status: "accepted" | "rejected") => void;
}) {
  const rows = useMemo(() => buildDiffRows(parts), [parts]);

  return (
    <div
      className={
        "rounded-lg border border-foreground/15 bg-background " +
        "overflow-y-auto font-mono text-xs leading-relaxed " +
        EDITOR_HEIGHT_CLASS
      }
    >
      {rows.map((row, i) => (
        <DiffRow key={i} row={row} onHunkDecision={onHunkDecision} />
      ))}
    </div>
  );
}

// One row in the diff view. Either body content (context/removed/added)
// or a per-hunk control row with the accept/reject buttons.
type DiffRowData =
  | { kind: "context"; lineNum: number; text: string }
  | {
      kind: "removed";
      lineNum: number;
      text: string;
      hunkId: string;
      status: "pending" | "accepted" | "rejected";
    }
  | {
      kind: "added";
      text: string;
      hunkId: string;
      status: "pending" | "accepted" | "rejected";
    }
  | {
      kind: "controls";
      hunkId: string;
      status: "pending" | "accepted" | "rejected";
    };

function DiffRow({
  row,
  onHunkDecision,
}: {
  row: DiffRowData;
  onHunkDecision: (id: string, status: "accepted" | "rejected") => void;
}) {
  // Shared cell classes. The gutter is fixed-width and right-aligned so
  // numbers line up with the textarea's gutter when the user toggles
  // between modes. The content cell wraps long lines and adds pl-4 of
  // breathing room from the gutter so the first character isn't kissing
  // the line-number column (matches the textarea's left padding).
  const gutterCell =
    "shrink-0 w-11 px-2 text-right select-none text-foreground/40";
  const contentCell =
    "flex-1 min-w-0 pl-4 pr-3 whitespace-pre-wrap break-words";

  if (row.kind === "context") {
    return (
      <div className="flex text-foreground/70">
        <span className={gutterCell}>{row.lineNum}</span>
        {/* nbsp keeps the row at full height for empty lines so the
            gutter doesn't collapse next to a blank body line. */}
        <span className={contentCell}>{row.text || " "}</span>
      </div>
    );
  }

  if (row.kind === "removed") {
    // Fade out once accepted (the removed content won't end up in the
    // merged body); stay red while pending or actively rejected.
    const fade = row.status === "accepted";
    return (
      <div
        className={
          "flex " +
          (fade
            ? "opacity-40 line-through"
            : "bg-red-500/10 text-red-700 dark:text-red-300")
        }
      >
        <span className={gutterCell + " text-red-500/70"}>{row.lineNum}</span>
        <span className={contentCell}>{row.text || " "}</span>
      </div>
    );
  }

  if (row.kind === "added") {
    // Fade out once rejected (the added content won't end up in the
    // merged body); stay green while pending or actively accepted.
    const fade = row.status === "rejected";
    return (
      <div
        className={
          "flex " +
          (fade
            ? "opacity-40 line-through"
            : "bg-green-500/10 text-green-700 dark:text-green-300")
        }
      >
        <span className={gutterCell + " text-green-600/70"}>+</span>
        <span className={contentCell}>{row.text || " "}</span>
      </div>
    );
  }

  // controls — accept/reject buttons and a small status label, anchored
  // at the right edge of the row to make the diff feel like a review
  // surface.
  return (
    <div className="flex bg-foreground/[0.02] border-y border-foreground/10">
      <span className={gutterCell} />
      <span
        className={
          contentCell + " flex items-center justify-end gap-2 py-1"
        }
      >
        <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/50">
          {row.status}
        </span>
        <button
          type="button"
          onClick={() => onHunkDecision(row.hunkId, "rejected")}
          aria-label="Reject hunk"
          className={
            "h-6 w-6 inline-flex items-center justify-center rounded text-xs " +
            (row.status === "rejected"
              ? "bg-red-600 text-white"
              : "border border-foreground/15 text-foreground/60 hover:border-red-500 hover:text-red-600")
          }
        >
          <FaXmark />
        </button>
        <button
          type="button"
          onClick={() => onHunkDecision(row.hunkId, "accepted")}
          aria-label="Accept hunk"
          className={
            "h-6 w-6 inline-flex items-center justify-center rounded text-xs " +
            (row.status === "accepted"
              ? "bg-green-600 text-white"
              : "border border-foreground/15 text-foreground/60 hover:border-green-500 hover:text-green-600")
          }
        >
          <FaCheck />
        </button>
      </span>
    </div>
  );
}

// Walk the diff parts and emit per-line rows. The line-number counter
// follows the ORIGINAL body's line numbering: context and removed rows
// consume a counter slot (they exist in the original); added rows
// don't (they're new). Trailing newlines on a part collapse to a
// single line break — splitting "a\n" on "\n" yields ["a", ""], and
// we drop the empty tail to avoid rendering a phantom blank row at
// the end of every block.
function buildDiffRows(parts: DiffPart[]): DiffRowData[] {
  const rows: DiffRowData[] = [];
  let oldLine = 1;

  const splitLines = (text: string): string[] => {
    if (text === "") return [];
    const out = text.split("\n");
    if (out[out.length - 1] === "") out.pop();
    return out;
  };

  for (const part of parts) {
    if (part.kind === "unchanged") {
      for (const text of splitLines(part.value)) {
        rows.push({ kind: "context", lineNum: oldLine, text });
        oldLine++;
      }
      continue;
    }
    // hunk: emit removed lines first (paired with their original line
    // numbers), then added lines (no original number), then the control
    // row carrying the accept/reject buttons.
    for (const text of splitLines(part.removed)) {
      rows.push({
        kind: "removed",
        lineNum: oldLine,
        text,
        hunkId: part.id,
        status: part.status,
      });
      oldLine++;
    }
    for (const text of splitLines(part.added)) {
      rows.push({
        kind: "added",
        text,
        hunkId: part.id,
        status: part.status,
      });
    }
    rows.push({
      kind: "controls",
      hunkId: part.id,
      status: part.status,
    });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Diff helpers: build hunks from jsdiff output, and merge accepted hunks
// back into a single string.
// ---------------------------------------------------------------------------

function buildDiffParts(oldText: string, newText: string): DiffPart[] {
  const raw = diffLines(oldText, newText);
  const out: DiffPart[] = [];

  // Walk the jsdiff parts and group each consecutive run of changed
  // parts (added or removed) into one hunk. Unchanged parts flush the
  // current hunk and become context.
  let pendingRemoved = "";
  let pendingAdded = "";

  const flushHunk = () => {
    if (pendingRemoved || pendingAdded) {
      out.push({
        kind: "hunk",
        id: crypto.randomUUID(),
        removed: pendingRemoved,
        added: pendingAdded,
        status: "pending",
      });
      pendingRemoved = "";
      pendingAdded = "";
    }
  };

  for (const part of raw) {
    if (part.added) {
      pendingAdded += part.value;
    } else if (part.removed) {
      pendingRemoved += part.value;
    } else {
      flushHunk();
      out.push({ kind: "unchanged", value: part.value });
    }
  }
  flushHunk();

  return out;
}

function mergeParts(parts: DiffPart[]): string {
  let out = "";
  for (const p of parts) {
    if (p.kind === "unchanged") {
      out += p.value;
    } else if (p.status === "accepted") {
      out += p.added;
    } else if (p.status === "rejected") {
      out += p.removed;
    }
    // pending hunks shouldn't reach here — Apply is gated on allResolved.
  }
  return out;
}

// ---------------------------------------------------------------------------
// PostPreview — read-only markdown rendering of the post body.
//
// Sized to EDITOR_HEIGHT_CLASS so toggling between Edit and Preview
// doesn't bounce the page. Component overrides give the rendered post
// proper typography (real heading sizes, list bullets, link colors)
// instead of the cramped chat-bubble styling AssistantMarkdown uses.
// Empty body shows a small placeholder instead of an empty box.
// ---------------------------------------------------------------------------
function PostPreview({ body }: { body: string }) {
  const trimmed = body.trim();
  return (
    <div
      className={
        "rounded-lg border border-input bg-background p-5 " +
        "overflow-y-auto " +
        EDITOR_HEIGHT_CLASS
      }
    >
      {trimmed === "" ? (
        <p className="text-sm text-foreground/40 italic">
          Nothing to preview yet. Write something in Edit mode or ask the
          chat for a draft.
        </p>
      ) : (
        <div className="text-sm leading-relaxed flex flex-col gap-3">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: ({ children }) => (
                <h1 className="font-serif text-2xl tracking-tight mt-2">
                  {children}
                </h1>
              ),
              h2: ({ children }) => (
                <h2 className="font-serif text-xl tracking-tight mt-2">
                  {children}
                </h2>
              ),
              h3: ({ children }) => (
                <h3 className="font-semibold text-base mt-2">{children}</h3>
              ),
              h4: ({ children }) => (
                <h4 className="font-semibold text-sm mt-2">{children}</h4>
              ),
              p: ({ children }) => <p>{children}</p>,
              ul: ({ children }) => (
                <ul className="list-disc pl-6 space-y-1">{children}</ul>
              ),
              ol: ({ children }) => (
                <ol className="list-decimal pl-6 space-y-1">{children}</ol>
              ),
              blockquote: ({ children }) => (
                <blockquote className="border-l-2 border-foreground/20 pl-3 text-foreground/70">
                  {children}
                </blockquote>
              ),
              code: ({ children, className }) => {
                const isBlock = /language-/.test(className ?? "");
                return isBlock ? (
                  <pre className="bg-foreground/[0.06] rounded p-3 overflow-x-auto text-xs font-mono leading-relaxed">
                    <code>{children}</code>
                  </pre>
                ) : (
                  <code className="bg-foreground/[0.06] rounded px-1 py-0.5 text-[0.85em] font-mono">
                    {children}
                  </code>
                );
              },
              a: ({ children, href }) => (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[color:var(--brand)] underline hover:no-underline"
                >
                  {children}
                </a>
              ),
              hr: () => <hr className="border-foreground/15" />,
              // GFM tables — keep them compact so wide tables don't blow
              // out the preview width.
              table: ({ children }) => (
                <div className="overflow-x-auto">
                  <table className="text-xs border-collapse">{children}</table>
                </div>
              ),
              th: ({ children }) => (
                <th className="border border-foreground/15 px-2 py-1 text-left bg-foreground/[0.04]">
                  {children}
                </th>
              ),
              td: ({ children }) => (
                <td className="border border-foreground/15 px-2 py-1">
                  {children}
                </td>
              ),
            }}
          >
            {body}
          </ReactMarkdown>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// LinedTextarea — a textarea with a non-interactive line-number gutter.
//
// Built rather than adopted from a library because real code-editor
// components (CodeMirror, Monaco) are 100kb+ minified for a feature
// where we only need a counter aligned to the left margin. The gutter
// is a plain <div> column with one row per line of `value`, font-mono
// and matching line-height so the numbers stay aligned even as the
// user wraps long paragraphs. Scroll is synced from textarea → gutter
// (one-way) since the user can only scroll the textarea itself.
//
// The whole component is locked to EDITOR_HEIGHT_CLASS so it doesn't
// grow with content; the textarea handles overflow via its own scroll.
// ---------------------------------------------------------------------------
function LinedTextarea({
  id,
  value,
  onChange,
  placeholder,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // One entry per visual line. We count via newlines on `value`; long
  // unwrapped lines still get a single number — same convention as
  // every other editor. An empty document still shows line 1.
  const lineNumbers = useMemo(() => {
    const count = Math.max(1, value.split("\n").length);
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [value]);

  // Sync gutter scroll position with the textarea so the numbers stay
  // visually pinned to their lines as the user scrolls.
  function handleScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    if (gutterRef.current) {
      gutterRef.current.scrollTop = e.currentTarget.scrollTop;
    }
  }

  return (
    <div
      className={
        "flex rounded-lg border border-input bg-transparent overflow-hidden " +
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 " +
        "transition-colors " +
        EDITOR_HEIGHT_CLASS
      }
    >
      {/* Gutter. shrink-0 + min-w pin it at a fixed width so a long
          textarea line can never push it down to zero. overflow:hidden
          because we drive its scrollTop from the textarea below. */}
      <div
        ref={gutterRef}
        aria-hidden
        className={
          "shrink-0 select-none overflow-hidden bg-foreground/[0.03] " +
          "text-foreground/40 font-mono text-sm leading-relaxed " +
          "py-1.5 px-2 text-right border-r border-foreground/10 " +
          "min-w-[2.75rem] box-border"
        }
      >
        {lineNumbers.map((n) => (
          <div key={n}>{n}</div>
        ))}
      </div>

      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={handleScroll}
        placeholder={placeholder}
        spellCheck={false}
        // wrap=soft keeps long lines visible (no horizontal scroll) so a
        // wide markdown line can't disappear behind the gutter as the
        // textarea pans. min-w-0 lets the flex item actually shrink to
        // the available width rather than honoring its intrinsic
        // content-based width (which would create horizontal overflow
        // on long unbroken strings). overflow-x-hidden + break-words
        // belt-and-suspenders against URLs and unbroken tokens. pl-4
        // (rather than px-3) gives the text breathing room from the
        // gutter so the first character isn't visually touching the
        // line-number column.
        wrap="soft"
        className={
          "flex-1 min-w-0 resize-none bg-transparent outline-none " +
          "font-mono text-sm leading-relaxed py-1.5 pl-4 pr-3 " +
          "placeholder:text-muted-foreground " +
          "overflow-x-hidden break-words"
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// AutoGrowTextarea — chat-style input that grows with content up to a
// cap, then becomes internally scrollable.
//
// Implementation: every render we collapse the textarea to height:auto
// (so scrollHeight reflects the *current* content, not whatever the
// element was sized to previously), then set height to min(scrollHeight,
// MAX_PX). Below the cap the textarea grows; at the cap CSS overflow
// takes over and the textarea scrolls internally.
//
// Enter submits, Shift+Enter inserts a newline — same convention as
// every modern chat input. Disabled while a request is in flight to
// match the surrounding chat state.
// ---------------------------------------------------------------------------

// Roughly six 14px lines of leading-relaxed text. Past this, the user is
// writing a paragraph and probably wants to see all of it scrolled rather
// than have the input eat the whole chat panel.
const CHAT_INPUT_MAX_HEIGHT_PX = 144;

function AutoGrowTextarea({
  value,
  onChange,
  onSubmit,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (next: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Resize on every value change. The "auto first, then exact px"
  // dance is necessary because a textarea's scrollHeight reflects the
  // taller-of(content, current height), so without resetting to auto
  // first the box would only ever grow, never shrink as text is deleted.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, CHAT_INPUT_MAX_HEIGHT_PX)}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          onSubmit();
        }
      }}
      placeholder={placeholder}
      disabled={disabled}
      rows={1}
      // h-9 matches the Send button's height when collapsed. resize-none
      // disables the native drag-corner since we're driving height
      // programmatically. overflow-y-auto kicks in once the JS clamp
      // hits CHAT_INPUT_MAX_HEIGHT_PX, giving the scrolling behavior.
      className={
        "flex-1 rounded-md border border-foreground/15 bg-background px-2 py-1.5 " +
        "text-sm outline-none focus:border-foreground/40 " +
        "resize-none overflow-y-auto leading-relaxed " +
        "min-h-9 disabled:opacity-50 disabled:cursor-not-allowed"
      }
      style={{ maxHeight: `${CHAT_INPUT_MAX_HEIGHT_PX}px` }}
    />
  );
}
