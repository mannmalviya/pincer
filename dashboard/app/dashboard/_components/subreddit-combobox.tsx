"use client";

import { useEffect, useId, useRef, useState } from "react";
import { FaXmark } from "react-icons/fa6";

// ---------------------------------------------------------------------------
// SubredditCombobox — multi-select typeahead for picking one or more
// subreddits to publish to.
//
// Layout: selected subreddits render inline as removable chips, followed
// by a typing input that autocompletes against /api/reddit/subreddits
// (which proxies Reddit's autocomplete endpoint server-side because
// reddit.com doesn't return CORS headers).
//
// Keyboard:
//   - Arrow down / up : move highlight in the dropdown
//   - Enter           : commit highlighted suggestion (or current typed
//                       text if no suggestion is highlighted) as a chip
//   - Escape          : close the dropdown
//   - Backspace on empty input : remove the last chip (standard
//                                multi-select convention)
//
// Duplicates are silently ignored — adding the same sub twice does
// nothing rather than producing two chips. The order of chips reflects
// insertion order, which is also the order the parent uses when
// fanning out Publish calls.
// ---------------------------------------------------------------------------

type Suggestion = { name: string; subscribers: number };

// Debounce delay between the last keystroke and firing the API call.
// 200ms keeps the dropdown responsive without hammering Reddit's
// autocomplete on every keystroke from fast typists.
const DEBOUNCE_MS = 200;

export function SubredditCombobox({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  id?: string;
}) {
  // Generated id so the dropdown's aria-controls / aria-activedescendant
  // wiring is stable across multiple comboboxes on the same page.
  const reactId = useId();
  const inputId = id ?? `subreddit-${reactId}`;
  const listboxId = `${inputId}-listbox`;

  // The text the user is currently typing (NOT yet committed as a chip).
  const [draft, setDraft] = useState("");
  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  // -1 = no row highlighted. Lets Enter fall through to commit the raw
  // draft text rather than always grabbing the first suggestion.
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);

  // Wrapper ref drives the "click outside to dismiss" detector.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Debounced fetch. AbortController + clearTimeout on each new keystroke
  // ensure an out-of-order response from a stale request can't overwrite
  // a newer one's results.
  useEffect(() => {
    if (!open) return;
    const trimmed = draft.trim().replace(/^r\//i, "");
    if (trimmed.length < 2) {
      setItems([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const handle = window.setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/reddit/subreddits?q=${encodeURIComponent(trimmed)}`,
          { signal: controller.signal },
        );
        const data = (await res.json()) as { items?: Suggestion[] };
        setItems(data.items ?? []);
        setHighlight(-1);
      } catch {
        // Aborted or network blip; leave items alone so a flicker of
        // the previous dropdown stays on screen until the next tick.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [draft, open]);

  // Dismiss the dropdown when the user clicks anywhere outside the
  // wrapper. Listening on mousedown (not click) catches the down-stroke
  // so the dropdown collapses before focus moves — no flash of stale UI.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [open]);

  // Add a subreddit to the chip list. Dedupe is case-insensitive so
  // "Test" and "test" don't both end up as chips for r/test.
  function add(name: string) {
    const cleaned = name.trim().replace(/^r\//i, "");
    if (!cleaned) return;
    const lower = cleaned.toLowerCase();
    if (value.some((v) => v.toLowerCase() === lower)) {
      // Already chipped — just clear the draft and re-focus.
      setDraft("");
      setHighlight(-1);
      inputRef.current?.focus();
      return;
    }
    onChange([...value, cleaned]);
    setDraft("");
    setHighlight(-1);
    inputRef.current?.focus();
  }

  function remove(name: string) {
    onChange(value.filter((v) => v !== name));
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      if (!open) setOpen(true);
      setHighlight((h) => (items.length === 0 ? -1 : (h + 1) % items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setHighlight((h) =>
        items.length === 0 ? -1 : (h - 1 + items.length) % items.length,
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      // Prefer the highlighted suggestion; if none, commit the raw
      // typed draft so the user can add arbitrary sub names without
      // waiting for autocomplete.
      if (open && highlight >= 0 && items[highlight]) {
        add(items[highlight].name);
      } else if (draft.trim()) {
        add(draft);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setHighlight(-1);
      }
    } else if (e.key === "Tab") {
      if (open && highlight >= 0 && items[highlight]) {
        add(items[highlight].name);
      }
    } else if (e.key === "Backspace" && draft === "" && value.length > 0) {
      // Standard multi-select gesture: backspace on an empty input
      // pops the most recently added chip.
      e.preventDefault();
      onChange(value.slice(0, -1));
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      {/* Outer wrapper styled like an input so chips + draft input
          look like one cohesive control. focus-within lights up the
          ring when the inner input is focused. */}
      <div
        className={
          "flex flex-wrap items-center gap-1.5 min-h-9 w-full rounded-lg " +
          "border border-input bg-transparent px-2 py-1 " +
          "focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 " +
          "transition-colors cursor-text"
        }
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((sub) => (
          <span
            key={sub}
            className="inline-flex items-center gap-1 rounded-full bg-[color:var(--brand)]/10 text-[color:var(--brand)] text-xs font-medium px-2 py-0.5"
          >
            <span className="font-mono">r/{sub}</span>
            <button
              type="button"
              onClick={(e) => {
                // Stop the wrapper's onClick from focusing the input
                // back; the user likely just wanted to delete the chip.
                e.stopPropagation();
                remove(sub);
              }}
              aria-label={`Remove r/${sub}`}
              className="inline-flex items-center justify-center h-4 w-4 rounded-full hover:bg-[color:var(--brand)]/20"
            >
              <FaXmark className="text-[10px]" />
            </button>
          </span>
        ))}
        {/* The typing input. flex-1 lets it grow to fill remaining
            space on the row; min-w-[6rem] keeps it usable even when
            many chips are wrapping. */}
        <input
          ref={inputRef}
          id={inputId}
          value={draft}
          onChange={(e) => {
            // Defensive strip of pasted "r/" prefix so a paste of
            // "r/SideProject" doesn't end up as "r/r/SideProject" when
            // committed.
            setDraft(e.target.value.replace(/^r\//i, ""));
            if (!open) setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length === 0 ? placeholder : ""}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          aria-autocomplete="list"
          aria-activedescendant={
            highlight >= 0 ? `${listboxId}-opt-${highlight}` : undefined
          }
          className={
            "flex-1 min-w-[6rem] bg-transparent outline-none text-sm " +
            "placeholder:text-muted-foreground py-0.5"
          }
        />
      </div>

      {open && (items.length > 0 || loading) && (
        <ul
          id={listboxId}
          role="listbox"
          className={
            "absolute z-20 left-0 right-0 mt-1 max-h-72 overflow-y-auto " +
            "rounded-md border border-foreground/15 bg-background shadow-lg " +
            "text-sm"
          }
        >
          {loading && items.length === 0 && (
            <li className="px-3 py-2 text-foreground/50">Searching...</li>
          )}
          {items.map((item, i) => {
            const active = i === highlight;
            const already = value.some(
              (v) => v.toLowerCase() === item.name.toLowerCase(),
            );
            return (
              <li
                key={item.name}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={active}
                onMouseDown={(e) => {
                  // mousedown rather than click — click fires after the
                  // input's blur, which would close the dropdown via the
                  // outside-click handler before the selection lands.
                  e.preventDefault();
                  if (!already) add(item.name);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={
                  "px-3 py-2 flex items-center justify-between gap-3 " +
                  (already
                    ? "text-foreground/30 cursor-default"
                    : "cursor-pointer ") +
                  (active && !already ? "bg-foreground/5" : "")
                }
              >
                <span className="font-medium tracking-tight">
                  r/{item.name}
                </span>
                <span className="text-xs font-mono text-foreground/50">
                  {already ? "added" : formatSubscribers(item.subscribers)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Compact subscriber counts. 1234567 -> "1.2M", 23000 -> "23k". Keeps
// the dropdown rows visually quiet instead of dumping seven-digit
// numbers next to every row.
function formatSubscribers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
