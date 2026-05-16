"use client";

// ---------------------------------------------------------------------------
// PlatformMarquee — horizontally-scrolling "Works with" strip for the
// landing page. Shows the five platforms Pincer supports (or will support):
// Reddit, X, Hacker News, Discord, Vercel.
//
// Implementation: classic seamless-loop trick. Render the platform list
// twice in a row, then translate the inner container from 0 % to -50 % of
// its own width on an infinite linear loop. Because the second half is an
// exact duplicate of the first, the moment the loop resets is visually
// indistinguishable from the rest of the scroll.
//
// Edges are masked with a horizontal linear-gradient so logos fade in/out
// instead of clipping hard against the section boundaries.
//
// Animation is disabled when the user has `prefers-reduced-motion: reduce`
// — `useReducedMotion` reads the OS-level setting and we drop the
// `animate` prop so the row sits still (mask still applies, just no loop).
// ---------------------------------------------------------------------------

import type { ComponentType } from "react";
import {
  FaReddit,
  FaXTwitter,
  FaHackerNews,
  FaDiscord,
} from "react-icons/fa6";
import { SiVercel } from "react-icons/si";
import { motion, useReducedMotion } from "motion/react";

type Platform = {
  name: string;
  icon: ComponentType<{ className?: string }>;
  // X's logo IS the letter X, so rendering "🅧 X" reads as a stutter.
  // Setting this skips the visible wordmark while keeping `name` available
  // for the chip's aria-label, so screen readers still announce "X".
  hideLabel?: boolean;
};

// Ordering picked for visual rhythm — Reddit + X anchor the front since
// they're the most recognizable wordmarks; Vercel closes the loop because
// it's the most "developer-tool" of the set.
const PLATFORMS: Platform[] = [
  { name: "Reddit", icon: FaReddit },
  { name: "X", icon: FaXTwitter, hideLabel: true },
  { name: "Hacker News", icon: FaHackerNews },
  { name: "Discord", icon: FaDiscord },
  { name: "Vercel", icon: SiVercel },
];

// Mask gradient hides the hard left/right edges of the scrolling row.
// Authored once so the inline `style` block stays readable. Both `mask`
// and `-webkit-mask` set for Safari compatibility.
const FADE_MASK =
  "linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)";

// Number of times the platform list is repeated in the DOM. The seamless
// loop translates by exactly one list-length (1/COPIES of the row's total
// width), so we need enough copies that even at the wrap point the visible
// window is still landing on real content. The required minimum is
// roughly `⌈1 + viewport / one-list-width⌉`. With current chip sizing one
// list is ~1100px, so 4 copies (~4400px total) cover monitors up to ~3300px
// wide. Bump this if the row ever appears to "end" on an ultrawide.
const COPIES = 4;
const TRACK = Array.from({ length: COPIES }, () => PLATFORMS).flat();
// Translating from 0 % to `LOOP_END` covers exactly one list — because the
// list to the right of that point is an identical copy, the snap-back is
// visually invisible.
const LOOP_END = `-${100 / COPIES}%`;

export function PlatformMarquee() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="border-t border-foreground/10 px-6 py-16">
      <p className="font-sans text-xs uppercase tracking-wider text-foreground/50 text-center mb-9">
        Works with
      </p>

      <div
        className="overflow-hidden"
        style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
      >
        <motion.ul
          // Each chip carries its own trailing margin (`mr-20`) instead of
          // the parent using flex `gap`. Why: flex-gap puts spacing *between*
          // items only, so for n items there are n-1 gaps. The `-50%`
          // translate assumes n equal periods of (chip + gap), so flex-gap
          // leaves the loop half-a-gap short → visible snap each cycle.
          // With margin-right on every chip, total width = n × (chip + gap)
          // and -50% lands exactly on one cycle. Seamless.
          className="flex w-max text-foreground/55"
          // `animate={undefined}` (the reduced-motion branch) leaves the row
          // at its rest position. Otherwise we keyframe x from 0% to
          // LOOP_END — exactly one list-length of the duplicated track.
          animate={reduceMotion ? undefined : { x: ["0%", LOOP_END] }}
          transition={{
            duration: 30,
            ease: "linear",
            repeat: Infinity,
            repeatType: "loop",
          }}
        >
          {TRACK.map((p, i) => (
            <PlatformChip
              key={i}
              platform={p}
              // Only the first copy is real; the remaining COPIES-1 copies
              // are filler so the row never runs out of content during the
              // loop. Hide them from screen readers to keep the announced
              // list clean.
              ariaHidden={i >= PLATFORMS.length}
            />
          ))}
        </motion.ul>
      </div>
    </section>
  );
}

function PlatformChip({
  platform,
  ariaHidden = false,
}: {
  platform: Platform;
  ariaHidden?: boolean;
}) {
  const Icon = platform.icon;
  return (
    <li
      // mr-20 is the inter-chip spacing — see note on motion.ul about why
      // it's a per-item margin instead of parent flex-gap.
      className="flex items-center gap-4 shrink-0 mr-20"
      // When the wordmark is hidden, the chip has no text content, so we
      // expose the name to assistive tech via aria-label.
      aria-label={platform.hideLabel ? platform.name : undefined}
      aria-hidden={ariaHidden || undefined}
    >
      <Icon className="text-4xl" />
      {!platform.hideLabel && (
        <span className="font-serif text-3xl tracking-tight">
          {platform.name}
        </span>
      )}
    </li>
  );
}
