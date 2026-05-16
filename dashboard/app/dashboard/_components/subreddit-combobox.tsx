"use client";

import { useEffect, useId, useRef, useState } from "react";

import { Input } from "@/components/ui/input";

// ---------------------------------------------------------------------------
// SubredditCombobox — typeahead-style input for picking a subreddit.
//
// Drops into the New Post page in place of a plain <Input>. As the user
// types, it hits /api/reddit/subreddits (Next.js route handler that
// proxies Reddit's autocomplete endpoint, since Reddit doesn't allow
// CORS) and renders a dropdown of matches. Click or arrow+enter to
// commit a suggestion.
//
// Keyboard:
//   - Arrow down / up : move highlight
//   - Enter           : pick the highlighted item (if any)
//   - Escape          : close the dropdown
//   - Tab             : commit highlight + close, native focus moves on
//
// The component is stateless about errors: empty results from the API
// just show "no suggestions" and a transient fetch error shows nothing,
// because the user can always type the name in by hand.
// ---------------------------------------------------------------------------

type Suggestion = { name: string; subscribers: number };

// Debounce delay between the last keystroke and firing the API call.
// 200ms keeps the dropdown feeling responsive while collapsing rapid
// typing into a single request. Smaller numbers (<=120ms) start hitting
// Reddit's rate limiter on quick typists.
const DEBOUNCE_MS = 200;

export function SubredditCombobox({
  value,
  onChange,
  placeholder,
  id,
}: {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  id?: string;
}) {
  // Generated id so the dropdown's aria-controls / aria-activedescendant
  // wiring is stable even when multiple comboboxes mount on the same page.
  const reactId = useId();
  const inputId = id ?? `subreddit-${reactId}`;
  const listboxId = `${inputId}-listbox`;

  const [items, setItems] = useState<Suggestion[]>([]);
  const [open, setOpen] = useState(false);
  // -1 = no row highlighted. Lets Enter fall through as form submit when
  // no suggestion is selected, instead of grabbing an arbitrary one.
  const [highlight, setHighlight] = useState(-1);
  const [loading, setLoading] = useState(false);

  // Wrapper ref drives the "click outside to dismiss" detector.
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Debounced fetch. Each keystroke schedules a fetch DEBOUNCE_MS in the
  // future; if another keystroke arrives first, the older timer is
  // cancelled. AbortController makes sure an out-of-order response from
  // a stale fetch can't overwrite a newer one's results.
  useEffect(() => {
    if (!open) return;
    const trimmed = value.trim().replace(/^r\//i, "");
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
        // Aborted or network blip. Leave items as-is so a flicker of
        // the previous dropdown stays on screen until the next tick.
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(handle);
    };
  }, [value, open]);

  // Dismiss on click anywhere outside the wrapper. Listening on mousedown
  // (not click) catches the down-stroke, so the dropdown collapses before
  // the focus moves and you don't see a flash of "still open".
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

  function commit(suggestion: Suggestion) {
    onChange(suggestion.name);
    setOpen(false);
    setHighlight(-1);
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
      // Only intercept Enter when a suggestion is highlighted, otherwise
      // let the keystroke pass through (form submit, default behavior).
      if (open && highlight >= 0 && items[highlight]) {
        e.preventDefault();
        commit(items[highlight]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setHighlight(-1);
      }
    } else if (e.key === "Tab") {
      // Tab commits the highlighted item (if any) and keeps default focus
      // movement, so the user can typeahead-then-tab without thinking.
      if (open && highlight >= 0 && items[highlight]) {
        commit(items[highlight]);
      }
    }
  }

  return (
    <div ref={wrapperRef} className="relative">
      {/* Hardcoded r/ prefix so the user doesn't try to type it themselves
          (which would produce "r/r/SideProject" in the request). The span
          is pointer-events-none so clicking on it still focuses the
          underlying input; the input's pl-8 leaves room for the glyph. */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-foreground/60 select-none"
      >
        r/
      </span>
      <Input
        id={inputId}
        value={value}
        onChange={(e) => {
          // Defensive strip in case the user pastes "r/foo" — without
          // this the rendered field would read "r/r/foo" thanks to the
          // hardcoded prefix above.
          const next = e.target.value.replace(/^r\//i, "");
          onChange(next);
          if (!open) setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        autoComplete="off"
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-autocomplete="list"
        aria-activedescendant={
          highlight >= 0 ? `${listboxId}-opt-${highlight}` : undefined
        }
        className="pl-8"
      />

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
            return (
              <li
                key={item.name}
                id={`${listboxId}-opt-${i}`}
                role="option"
                aria-selected={active}
                // mousedown rather than click — click fires after the
                // input's blur, which would close the dropdown via the
                // outside-click handler before the selection lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  commit(item);
                }}
                onMouseEnter={() => setHighlight(i)}
                className={
                  "px-3 py-2 cursor-pointer flex items-center justify-between gap-3 " +
                  (active ? "bg-foreground/5" : "")
                }
              >
                <span className="font-medium tracking-tight">
                  r/{item.name}
                </span>
                <span className="text-xs font-mono text-foreground/50">
                  {formatSubscribers(item.subscribers)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// Compact subscriber counts. 1234567 → "1.2M", 23000 → "23k". Keeps the
// dropdown rows visually quiet instead of dumping seven-digit numbers
// next to every row.
function formatSubscribers(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return String(n);
}
