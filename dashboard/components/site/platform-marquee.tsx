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
};

// Ordering picked for visual rhythm — Reddit + X anchor the front since
// they're the most recognizable wordmarks; Vercel closes the loop because
// it's the most "developer-tool" of the set.
const PLATFORMS: Platform[] = [
  { name: "Reddit", icon: FaReddit },
  { name: "X", icon: FaXTwitter },
  { name: "Hacker News", icon: FaHackerNews },
  { name: "Discord", icon: FaDiscord },
  { name: "Vercel", icon: SiVercel },
];

// Mask gradient hides the hard left/right edges of the scrolling row.
// Authored once so the inline `style` block stays readable. Both `mask`
// and `-webkit-mask` set for Safari compatibility.
const FADE_MASK =
  "linear-gradient(to right, transparent 0%, black 8%, black 92%, transparent 100%)";

export function PlatformMarquee() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="border-t border-foreground/10 px-6 py-12">
      <p className="font-sans text-xs uppercase tracking-wider text-foreground/50 text-center mb-7">
        Works with
      </p>

      <div
        className="overflow-hidden"
        style={{ maskImage: FADE_MASK, WebkitMaskImage: FADE_MASK }}
      >
        <motion.ul
          className="flex gap-12 w-max text-foreground/55"
          // `animate={undefined}` (the reduced-motion branch) leaves the row
          // at its rest position. Otherwise we keyframe x from 0% to -50%
          // of the row's own width — exactly one duplicated list-length.
          animate={reduceMotion ? undefined : { x: ["0%", "-50%"] }}
          transition={{
            duration: 30,
            ease: "linear",
            repeat: Infinity,
            repeatType: "loop",
          }}
        >
          {[...PLATFORMS, ...PLATFORMS].map((p, i) => (
            <PlatformChip
              key={i}
              platform={p}
              // The duplicate half is filler for the seamless loop, so
              // hide it from screen readers — the original five are the
              // only ones we want announced.
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
      className="flex items-center gap-3 shrink-0"
      aria-hidden={ariaHidden || undefined}
    >
      <Icon className="text-2xl" />
      <span className="font-serif text-xl tracking-tight">{platform.name}</span>
    </li>
  );
}
