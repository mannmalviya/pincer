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
// A hunk lives in the parts list ONLY while it's still pending. The
// moment the user accepts or rejects it, we replace it with an
// "unchanged" part carrying either the added or removed text — so the
// status field would only ever be "pending" and is therefore not stored.
type DiffPart =
  | { kind: "unchanged"; value: string }
  | { kind: "hunk"; id: string; removed: string; added: string };

type Proposal = {
  // The model's full new body. Kept around so we have something to
  // compare against if we want to re-derive the diff after edits.
  proposedBody: string;
  parts: DiffPart[];
  // Optional title change. Same model: the title hunk is only present
  // while it's still pending. On decision it's applied and removed.
  titleHunk?: {
    id: string;
    oldTitle: string;
    newTitle: string;
  };
};

export function PostEditor({
  body,
  onBodyChange,
  title,
  onTitleChange,
  platform,
}: {
  body: string;
  onBodyChange: (next: string) => void;
  title: string;
  onTitleChange: (next: string) => void;
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

  // Last non-empty selection the user made in the body textarea. When
  // present, the chat panel shows a "context chip" and the next sent
  // message is augmented with a blockquote containing the selected
  // text and line range. Cleared after send (or when the user dismisses
  // the chip explicitly).
  const [selection, setSelection] = useState<EditorSelection | null>(null);

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

    // If the user has a selection in the body, fold it into the message
    // as a quoted context block. Markdown renders the blockquote nicely
    // in the chat bubble AND the model sees the literal text + line
    // numbers so it knows exactly which slice to reason about.
    const content = selection
      ? buildContextualContent(selection, text)
      : text;
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    setMessages((cur) => [...cur, userMessage]);
    setInput("");
    setSending(true);
    setError(null);
    // Consume the selection — the user said what they wanted to say
    // about it, no reason to keep it attached to the next message.
    setSelection(null);
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
        newTitle?: string;
        error?: string;
      };
      if (!res.ok || !data.reply) {
        setError(data.error ?? "The model didn't return a reply.");
        return;
      }

      // The model can change the title, the body, both, or neither.
      // Anything else (a chat-only reply) leaves the post untouched.
      const bodyChanged =
        typeof data.newBody === "string" && data.newBody !== body;
      const titleChanged =
        typeof data.newTitle === "string" && data.newTitle !== title;

      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: "assistant",
        content: data.reply,
        hadProposal: bodyChanged || titleChanged,
      };
      setMessages((cur) => [...cur, assistantMessage]);

      if (bodyChanged || titleChanged) {
        setProposal({
          proposedBody: bodyChanged ? data.newBody! : body,
          // If the body didn't change, the parts list is just one
          // "unchanged" entry — no body hunks, but the title hunk
          // below still drives the auto-apply gating.
          parts: bodyChanged
            ? buildDiffParts(body, data.newBody!)
            : [{ kind: "unchanged", value: body }],
          titleHunk: titleChanged
            ? {
                id: crypto.randomUUID(),
                oldTitle: title,
                newTitle: data.newTitle!,
              }
            : undefined,
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

  // Each hunk decision is independent: clicking ✓ or ✗ on a hunk
  // applies that one change to the body (or title) RIGHT NOW and
  // removes it from the diff. The diff only renders the hunks still
  // awaiting a decision, so the view shrinks one hunk at a time as the
  // user works through them. When nothing's left pending, the
  // proposal closes and the user is back in the textarea.
  //
  // Implementation: we read the current proposal from the closure
  // (each click is its own event so the closure is fresh), compute
  // the next state + the side effects (onBodyChange / onTitleChange),
  // then call the setters at top level. We can't put onTitleChange /
  // onBodyChange inside a `setProposal((prev) => ...)` updater because
  // that callback runs during the render scheduling phase — calling
  // a parent setState from there triggers React's "setState during
  // render of another component" error.
  function setHunkStatus(
    hunkId: string,
    status: "accepted" | "rejected",
  ): void {
    if (!proposal) return;

    // Title hunk: apply or discard, then remove. No parts mutation.
    if (proposal.titleHunk && proposal.titleHunk.id === hunkId) {
      if (status === "accepted") {
        onTitleChange(proposal.titleHunk.newTitle);
      }
      const stillPending = proposal.parts.some((p) => p.kind === "hunk");
      setProposal(stillPending ? { ...proposal, titleHunk: undefined } : null);
      return;
    }

    // Body hunk: convert to "unchanged" with whichever side the user
    // picked. Then derive the new body from the updated parts list
    // (unchanged values + still-pending hunks' original `removed`
    // content) and commit it.
    const newParts: DiffPart[] = proposal.parts.map((p) => {
      if (p.kind === "hunk" && p.id === hunkId) {
        return {
          kind: "unchanged",
          value: status === "accepted" ? p.added : p.removed,
        };
      }
      return p;
    });
    const newBody = newParts.reduce((acc, p) => {
      if (p.kind === "unchanged") return acc + p.value;
      // Still-pending hunk: keep the original (removed) content so
      // the body doesn't jump ahead of the user's decisions.
      return acc + p.removed;
    }, "");
    onBodyChange(newBody);

    const stillPendingBody = newParts.some((p) => p.kind === "hunk");
    const stillPendingTitle = proposal.titleHunk !== undefined;
    setProposal(
      !stillPendingBody && !stillPendingTitle
        ? null
        : { ...proposal, parts: newParts },
    );
  }

  // Batched "accept everything that's still pending" used by the
  // type-to-accept gesture inside the diff view. Doing this as one
  // call (instead of calling setHunkStatus in a loop) avoids racing
  // the closure: each setHunkStatus would otherwise read the same
  // stale `proposal` and overwrite each other's setProposal results.
  function acceptAllPending(): void {
    if (!proposal) return;
    const newParts: DiffPart[] = proposal.parts.map((p) =>
      p.kind === "hunk" ? { kind: "unchanged", value: p.added } : p,
    );
    const newBody = newParts.reduce(
      (acc, p) => (p.kind === "unchanged" ? acc + p.value : acc),
      "",
    );
    if (newBody !== body) onBodyChange(newBody);
    if (proposal.titleHunk) onTitleChange(proposal.titleHunk.newTitle);
    setProposal(null);
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_320px] gap-6">
      {/* Left column: textarea / diff review / preview. All three
          variants use the same fixed height (EDITOR_HEIGHT_CLASS) so
          the page layout doesn't reflow when toggling between them.
          min-w-0 on this column is load-bearing: without it, the grid
          item defaults to min-width:auto (= intrinsic content width),
          and a wide textarea would push the column past its 1fr share.
          Combined with minmax(0,1fr) on the grid track above, this
          lets the textarea actually shrink to the cell's width so
          wrap="soft" wraps at the visible boundary instead of off-screen. */}
      <div className="flex flex-col gap-2 min-w-0">
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
        {(() => {
          // Title input lives in the editor card's header in BOTH the
          // textarea and diff modes — keeping it mounted across mode
          // switches means it stays visible when the user accepts the
          // title hunk mid-diff (previously the input only existed
          // inside LinedTextarea's header, so accepting the title
          // briefly hid it until the body hunks were also resolved).
          const titleInput = (
            <input
              type="text"
              value={title}
              onChange={(e) => onTitleChange(e.target.value)}
              placeholder="Title (e.g. Show HN: Pincer)"
              maxLength={300}
              aria-label="Post title"
              className={
                "w-full bg-transparent outline-none " +
                "font-serif text-lg tracking-tight " +
                "px-3 py-2 placeholder:text-muted-foreground"
              }
            />
          );

          if (proposal) {
            return (
              <DiffReview
                parts={proposal.parts}
                titleHunk={proposal.titleHunk}
                onHunkDecision={setHunkStatus}
                onAcceptAll={acceptAllPending}
                header={titleInput}
              />
            );
          }
          if (previewing) {
            return <PostPreview title={title} body={body} />;
          }
          return (
            <LinedTextarea
              id="post-body"
              value={body}
              onChange={onBodyChange}
              onSelectionChange={setSelection}
              placeholder="Write your post here. Markdown works on Reddit and HN."
              header={titleInput}
            />
          );
        })()}
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

        {/* Context chip — appears the moment the user makes a non-empty
            selection in the body. Shows the line range + a preview of
            the snippet; clicking the X clears it without sending. On
            send, sendMessage folds the snippet into the message and
            then clears this. */}
        {selection && (
          <SelectionChip
            selection={selection}
            onDismiss={() => setSelection(null)}
          />
        )}

        <div className="border-t border-foreground/10 p-2 flex gap-2 items-end">
          <AutoGrowTextarea
            value={input}
            onChange={setInput}
            onSubmit={sendMessage}
            disabled={sending}
            placeholder={
              selection ? "Ask about the selection..." : "Ask the model..."
            }
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
// SelectionChip — small affordance shown in the chat panel when the user
// has a non-empty selection in the body editor. Tells them what's about
// to be attached to their next message and gives them a way to bail.
// ---------------------------------------------------------------------------
function SelectionChip({
  selection,
  onDismiss,
}: {
  selection: EditorSelection;
  onDismiss: () => void;
}) {
  const range =
    selection.startLine === selection.endLine
      ? `Line ${selection.startLine}`
      : `Lines ${selection.startLine}–${selection.endLine}`;
  // Strip down to a one-line preview so a multi-line selection doesn't
  // blow up the chip's height. Trim each line so leading whitespace from
  // markdown indentation doesn't make the preview look empty.
  const preview =
    selection.text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .join(" / ")
      .slice(0, 60) || "(blank)";
  return (
    <div className="mx-2 mb-1 mt-2 rounded-md border border-[color:var(--brand)]/30 bg-[color:var(--brand)]/[0.06] px-2 py-1.5 flex items-center gap-2 text-xs">
      <span className="font-mono uppercase tracking-wider text-[color:var(--brand)] shrink-0">
        {range}
      </span>
      <span className="flex-1 min-w-0 truncate text-foreground/70 font-mono">
        {preview}
      </span>
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Remove selection from message"
        className="shrink-0 inline-flex h-5 w-5 items-center justify-center rounded text-foreground/50 hover:text-foreground hover:bg-foreground/10"
      >
        <FaXmark className="text-[10px]" />
      </button>
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
  titleHunk,
  onHunkDecision,
  onAcceptAll,
  header,
}: {
  parts: DiffPart[];
  // Optional atomic title change. Renders at the top of the diff with
  // its own ✓/✗ pair; titles are short and don't need per-character
  // hunk granularity.
  titleHunk?: {
    id: string;
    oldTitle: string;
    newTitle: string;
  };
  onHunkDecision: (id: string, status: "accepted" | "rejected") => void;
  // Type-to-accept short circuit. Resolves every pending hunk in a
  // single state update so multiple onHunkDecision calls don't race
  // each other through stale closures.
  onAcceptAll: () => void;
  // Optional pinned header inside the card (above the scrolling diff
  // body). Used to keep the title input visible across the diff so
  // accepting the title hunk doesn't briefly blank it out.
  header?: React.ReactNode;
}) {
  const rows = useMemo(() => buildDiffRows(parts), [parts]);
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-focus the diff container when a proposal appears so the
  // "type-to-accept" shortcut is reachable without an extra click.
  // Selectable text inside still works — selection is independent of
  // which element has keyboard focus.
  useEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, []);

  // Type-to-accept: any printable keystroke (or Enter/Backspace)
  // accepts every still-pending hunk. The useEffect upstream sees
  // allResolved flip to true and auto-applies, dropping the user
  // back into the textarea with the merged body. We intentionally
  // do NOT preventDefault — the keystroke is consumed by this flow
  // and not replayed in the textarea, which matches the user's
  // expectation that "I touched the diff, my decision is made".
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Skip events bubbling up from an actual interactive child
    // (the accept/reject buttons). Those have their own behavior.
    const target = e.target as HTMLElement | null;
    if (target && target.tagName === "BUTTON") return;
    // Modifier-only chords (Ctrl+C to copy a selection, etc.) shouldn't
    // count as "typing" — let copy/paste pass through cleanly.
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const isPrintable = e.key.length === 1;
    const isEditKey = e.key === "Enter" || e.key === "Backspace";
    if (!isPrintable && !isEditKey) return;
    // Only fire if there's actually something to resolve. The parent's
    // onAcceptAll resolves every pending hunk in one state update,
    // which sidesteps the closure-race problem of calling
    // onHunkDecision in a loop.
    const hasPending =
      parts.some((p) => p.kind === "hunk") || titleHunk !== undefined;
    if (!hasPending) return;
    onAcceptAll();
  }

  return (
    <div
      ref={containerRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      className={
        // Outer card is a flex column so the header strip (when
        // present) stays pinned at the top while the diff body
        // scrolls. focus-within so a click inside the header (the
        // title input) still lights up the card's ring.
        "flex flex-col rounded-lg border border-foreground/15 bg-background " +
        "font-mono text-xs leading-relaxed " +
        "outline-none focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 " +
        EDITOR_HEIGHT_CLASS
      }
    >
      {header && (
        <div className="shrink-0 border-b border-foreground/10">{header}</div>
      )}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {titleHunk && (
          <TitleHunkBlock hunk={titleHunk} onDecision={onHunkDecision} />
        )}
        {rows.map((row, i) => (
          <DiffRow key={i} row={row} onHunkDecision={onHunkDecision} />
        ))}
      </div>
    </div>
  );
}

// Visual block for the title-change hunk at the top of the diff. Renders
// the old title (rose) above the new title (emerald), then a controls
// row matching the body-hunk pattern. Sits above a thin divider so it
// reads as the "title strip" mirroring the editor card's layout.
function TitleHunkBlock({
  hunk,
  onDecision,
}: {
  hunk: {
    id: string;
    oldTitle: string;
    newTitle: string;
  };
  onDecision: (id: string, status: "accepted" | "rejected") => void;
}) {
  const gutterCell =
    "shrink-0 w-11 px-2 text-right select-none text-foreground/40 font-mono";
  const contentCell =
    "flex-1 min-w-0 pl-4 pr-3 font-serif text-base tracking-tight";

  // Hunks only appear in the proposal while still pending — the moment
  // a decision lands, the hunk is removed from the proposal and this
  // block unmounts. So no "accepted/rejected fade" branches; each
  // button click is final and immediately resolves the row.
  return (
    <>
      <div className="flex">
        <span className={gutterCell + " text-rose-600/70"}>T</span>
        <span
          className={
            contentCell +
            " bg-rose-500/12 text-rose-800 dark:text-rose-200 line-through"
          }
        >
          {hunk.oldTitle || " "}
        </span>
      </div>
      <div className="flex">
        <span className={gutterCell + " text-emerald-600/80"}>T</span>
        <span
          className={
            contentCell +
            " bg-emerald-500/12 text-emerald-800 dark:text-emerald-200"
          }
        >
          {hunk.newTitle || " "}
        </span>
      </div>
      <div className="flex bg-foreground/[0.02] border-y border-foreground/10">
        <span className={gutterCell} />
        <span className="flex-1 min-w-0 pl-4 pr-3 flex items-center justify-end gap-2 py-1">
          <span className="text-[10px] font-mono uppercase tracking-wider text-foreground/50">
            title change
          </span>
          <button
            type="button"
            onClick={() => onDecision(hunk.id, "rejected")}
            aria-label="Reject title change"
            className="h-6 w-6 inline-flex items-center justify-center rounded text-xs border border-foreground/15 text-foreground/60 hover:border-red-500 hover:text-red-600"
          >
            <FaXmark />
          </button>
          <button
            type="button"
            onClick={() => onDecision(hunk.id, "accepted")}
            aria-label="Accept title change"
            className="h-6 w-6 inline-flex items-center justify-center rounded text-xs border border-foreground/15 text-foreground/60 hover:border-green-500 hover:text-green-600"
          >
            <FaCheck />
          </button>
        </span>
      </div>
    </>
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
    }
  | {
      kind: "added";
      text: string;
      hunkId: string;
    }
  | {
      kind: "controls";
      hunkId: string;
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
    // Rendered only while the hunk is still pending — on decision the
    // hunk converts to "unchanged" upstream and this row unmounts.
    // So no fade variants: removed lines stay rose-tinted right up
    // until the moment they disappear.
    return (
      <div className="flex bg-rose-500/12 text-rose-800 dark:text-rose-200">
        <span className={gutterCell + " text-rose-600/70"}>{row.lineNum}</span>
        <span className={contentCell}>{row.text || " "}</span>
      </div>
    );
  }

  if (row.kind === "added") {
    return (
      <div className="flex bg-emerald-500/12 text-emerald-800 dark:text-emerald-200">
        <span className={gutterCell + " text-emerald-600/80"}>+</span>
        <span className={contentCell}>{row.text || " "}</span>
      </div>
    );
  }

  // controls — accept/reject buttons anchored at the right edge of
  // the row. Hunks are always pending while displayed (resolved hunks
  // unmount), so no active/selected-state styling.
  return (
    <div className="flex bg-foreground/[0.02] border-y border-foreground/10">
      <span className={gutterCell} />
      <span
        className={
          contentCell + " flex items-center justify-end gap-2 py-1"
        }
      >
        <button
          type="button"
          onClick={() => onHunkDecision(row.hunkId, "rejected")}
          aria-label="Reject hunk"
          className="h-6 w-6 inline-flex items-center justify-center rounded text-xs border border-foreground/15 text-foreground/60 hover:border-red-500 hover:text-red-600"
        >
          <FaXmark />
        </button>
        <button
          type="button"
          onClick={() => onHunkDecision(row.hunkId, "accepted")}
          aria-label="Accept hunk"
          className="h-6 w-6 inline-flex items-center justify-center rounded text-xs border border-foreground/15 text-foreground/60 hover:border-green-500 hover:text-green-600"
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
      });
      oldLine++;
    }
    for (const text of splitLines(part.added)) {
      rows.push({
        kind: "added",
        text,
        hunkId: part.id,
      });
    }
    rows.push({
      kind: "controls",
      hunkId: part.id,
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

// Formats a selection + user message into the literal string the model
// (and the user) will see in the chat. Markdown blockquote so the
// rendered bubble visually separates context from the user's prompt;
// line-number prefix so the model can refer back to specific lines
// when proposing an edit.
function buildContextualContent(
  sel: EditorSelection,
  userText: string,
): string {
  const range =
    sel.startLine === sel.endLine
      ? `line ${sel.startLine}`
      : `lines ${sel.startLine}–${sel.endLine}`;
  const quoted = sel.text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  return `**Selected ${range}:**\n${quoted}\n\n${userText}`;
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
function PostPreview({ title, body }: { title: string; body: string }) {
  const trimmedBody = body.trim();
  const trimmedTitle = title.trim();
  return (
    <div
      className={
        "rounded-lg border border-input bg-background p-5 " +
        "overflow-y-auto flex flex-col gap-4 " +
        EDITOR_HEIGHT_CLASS
      }
    >
      {trimmedTitle && (
        <h1 className="font-serif text-2xl tracking-tight">{trimmedTitle}</h1>
      )}
      {trimmedTitle && trimmedBody && (
        <hr className="border-foreground/10" />
      )}
      {trimmedBody === "" && trimmedTitle === "" ? (
        <p className="text-sm text-foreground/40 italic">
          Nothing to preview yet. Write something in Edit mode or ask the
          chat for a draft.
        </p>
      ) : trimmedBody === "" ? null : (
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
// Range payload emitted by LinedTextarea whenever the user makes a
// non-empty selection in the body. Consumed by the chat panel to attach
// the highlighted span as "context" to the next outgoing message.
export type EditorSelection = {
  startLine: number;
  endLine: number;
  text: string;
};

function LinedTextarea({
  id,
  value,
  onChange,
  onSelectionChange,
  placeholder,
  header,
}: {
  id?: string;
  value: string;
  onChange: (next: string) => void;
  onSelectionChange?: (sel: EditorSelection | null) => void;
  placeholder?: string;
  // Optional content to render inside the same bordered card, above the
  // line-numbered body. Used to fold the post's title input into the
  // editor card so title + body read as one unified "post" surface.
  header?: React.ReactNode;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const gutterRef = useRef<HTMLDivElement>(null);

  // One entry per logical line. We count via newlines on `value`; long
  // wrapped lines still get a single number — same convention as every
  // other editor. An empty document still shows line 1.
  const lineNumbers = useMemo(() => {
    const count = Math.max(1, value.split("\n").length);
    return Array.from({ length: count }, (_, i) => i + 1);
  }, [value]);

  // Current-line highlight bookkeeping. We track the logical line the
  // cursor sits on, the textarea's scroll offset, and whether the
  // textarea is focused — combining them positions the overlay stripe
  // (and bolds the matching gutter number) like a VS Code current-line
  // highlight.
  const [currentLine, setCurrentLine] = useState(1);
  const [scrollTop, setScrollTop] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  // Pixel line height of the textarea, read at mount. Used to position
  // the highlight overlay. We measure rather than hard-code so a future
  // font/leading change doesn't silently desync the overlay.
  const [lineHeightPx, setLineHeightPx] = useState(22.75);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    const parsed = parseFloat(getComputedStyle(el).lineHeight);
    if (!Number.isNaN(parsed) && parsed > 0) setLineHeightPx(parsed);
  }, []);

  // Recompute the cursor's logical line AND surface any non-empty
  // selection upward so the chat panel can offer it as context. Cheap:
  // two split-by-newline counts on substrings of the value. Called from
  // every event that can move the cursor or change the selection.
  function syncCurrentLine() {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart, selectionEnd, value: v } = el;
    const before = v.slice(0, selectionStart);
    setCurrentLine(before.split("\n").length);

    if (onSelectionChange) {
      if (selectionStart === selectionEnd) {
        onSelectionChange(null);
      } else {
        const upToEnd = v.slice(0, selectionEnd);
        onSelectionChange({
          startLine: before.split("\n").length,
          endLine: upToEnd.split("\n").length,
          text: v.slice(selectionStart, selectionEnd),
        });
      }
    }
  }

  // Sync gutter scroll position with the textarea so the numbers stay
  // visually pinned to their lines as the user scrolls. Also caches
  // scrollTop in state so the highlight overlay can re-position.
  function handleScroll(e: React.UIEvent<HTMLTextAreaElement>) {
    const top = e.currentTarget.scrollTop;
    setScrollTop(top);
    if (gutterRef.current) {
      gutterRef.current.scrollTop = top;
    }
  }

  // Vertical pixel offset of the highlight stripe inside the editor
  // container. py-1.5 on both textarea and gutter = 6px of padding-top.
  const PADDING_TOP_PX = 6;
  const overlayTop =
    PADDING_TOP_PX + (currentLine - 1) * lineHeightPx - scrollTop;
  // Width of the gutter column — same as min-w-[2.75rem] = 44px. The
  // overlay starts AFTER the gutter so the line-number column isn't
  // shaded over.
  const GUTTER_WIDTH_PX = 44;
  const overlayVisible =
    isFocused &&
    overlayTop > -lineHeightPx &&
    overlayTop < (textareaRef.current?.clientHeight ?? Infinity);

  return (
    <div
      className={
        // Outer card: flex column so an optional header strip can sit
        // above the gutter+textarea row, sharing the border and focus
        // ring. EDITOR_HEIGHT_CLASS pins the card; min-h-0 on the body
        // row below lets the textarea claim the remaining space.
        "flex flex-col min-w-0 rounded-lg border border-input bg-transparent overflow-hidden " +
        "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 " +
        "transition-colors " +
        EDITOR_HEIGHT_CLASS
      }
    >
      {header && (
        <div className="shrink-0 border-b border-foreground/10">{header}</div>
      )}

      <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden">
      {/* Current-line highlight overlay. Absolutely positioned within
          this body row (not the outer card) so its y math doesn't have
          to account for the header's height. Excluded from pointer
          events so clicks pass through to the textarea. */}
      {overlayVisible && (
        <div
          aria-hidden
          className="absolute pointer-events-none bg-foreground/[0.05]"
          style={{
            top: `${overlayTop}px`,
            left: `${GUTTER_WIDTH_PX}px`,
            right: 0,
            height: `${lineHeightPx}px`,
          }}
        />
      )}

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
        {lineNumbers.map((n) => {
          const active = isFocused && n === currentLine;
          return (
            <div
              key={n}
              className={active ? "text-foreground font-semibold" : ""}
            >
              {n}
            </div>
          );
        })}
      </div>

      <textarea
        ref={textareaRef}
        id={id}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          // Typing changes the cursor offset (it advances past the
          // inserted character). React's onChange fires after value
          // commits, so the selection is already in its new spot.
          syncCurrentLine();
        }}
        onScroll={handleScroll}
        // onSelect covers arrow-key + mouse-click cursor moves;
        // onKeyUp catches the edge cases where onSelect doesn't fire
        // (some browsers omit onSelect for cursor moves without
        // selection change). onClick + onFocus prime the line on
        // entry.
        onSelect={syncCurrentLine}
        onKeyUp={syncCurrentLine}
        onClick={syncCurrentLine}
        onFocus={() => {
          setIsFocused(true);
          syncCurrentLine();
        }}
        onBlur={() => setIsFocused(false)}
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
        // line-number column. relative + z-10 so the textarea's caret
        // and selection render on top of the highlight overlay.
        wrap="soft"
        className={
          "relative z-10 flex-1 min-w-0 resize-none bg-transparent outline-none " +
          "font-mono text-sm leading-relaxed py-1.5 pl-4 pr-3 " +
          "placeholder:text-muted-foreground " +
          "overflow-x-hidden break-words"
        }
      />
      </div>
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
