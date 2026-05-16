"use client";

import { useEffect, useState } from "react";
import { FaCheck } from "react-icons/fa6";

// ---------------------------------------------------------------------------
// Toast — small, transient, auto-dismissing notification.
//
// Renders fixed at the top center of the viewport via a parent ToastStack
// that holds an array of these. Slides in from above, sits for a few
// seconds, slides back out. Used today for "Posted successfully on X"
// confirmations on the New Post page; reusable for any future success
// confirmations.
//
// The component owns its own visible/hidden animation timing so the
// parent only needs to track which toasts exist, not their lifecycle
// inside the animation.
// ---------------------------------------------------------------------------

export type ToastItem = {
  id: string;
  message: string;
};

// Total time a toast is visible before fading out. Tuned to be readable
// without being annoying. The fade-out itself takes 200ms (see classes),
// so the underlying item is removed from the array after VISIBLE_MS + 200.
const VISIBLE_MS = 3000;
const FADE_OUT_MS = 200;

export function ToastStack({
  toasts,
  onDismiss,
}: {
  toasts: ToastItem[];
  onDismiss: (id: string) => void;
}) {
  // Fixed at the top center, above page content. pointer-events-none on
  // the container so a toast over the page doesn't block clicks; each
  // toast row re-enables pointer-events so its own hover works.
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 flex flex-col gap-2 pointer-events-none">
      {toasts.map((t) => (
        <Toast key={t.id} item={t} onDismiss={onDismiss} />
      ))}
    </div>
  );
}

function Toast({
  item,
  onDismiss,
}: {
  item: ToastItem;
  onDismiss: (id: string) => void;
}) {
  // Two-stage animation: mount in the "entering" state with opacity-0 +
  // translate-y-(-2), flip to visible on the next frame, then schedule
  // the leave transition before the parent removes us.
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    // requestAnimationFrame so the initial render commits in the hidden
    // state before we flip — otherwise Tailwind merges both states into
    // the first paint and the transition doesn't run.
    const rafHandle = requestAnimationFrame(() => setVisible(true));

    const hideHandle = window.setTimeout(() => {
      setVisible(false);
    }, VISIBLE_MS);

    const removeHandle = window.setTimeout(() => {
      onDismiss(item.id);
    }, VISIBLE_MS + FADE_OUT_MS);

    return () => {
      cancelAnimationFrame(rafHandle);
      window.clearTimeout(hideHandle);
      window.clearTimeout(removeHandle);
    };
  }, [item.id, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className={
        "pointer-events-auto flex items-center gap-2 rounded-full " +
        "bg-green-600 text-white pl-2 pr-4 py-1.5 shadow-lg text-sm " +
        "transition-all duration-200 ease-out " +
        (visible
          ? "opacity-100 translate-y-0"
          : "opacity-0 -translate-y-2")
      }
    >
      <span className="inline-flex items-center justify-center w-5 h-5 rounded-full bg-white/20">
        <FaCheck className="text-xs" />
      </span>
      <span className="font-medium">{item.message}</span>
    </div>
  );
}
