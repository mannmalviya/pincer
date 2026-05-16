"use client";

// ---------------------------------------------------------------------------
// FeaturesShowcase — the "what Pincer actually does" section on the landing
// page. Replaces the earlier static three-up "What you get" block with four
// animated cards: drafts, watches, surfaces analytics, replies-with-leash.
//
// Lives in components/site/ alongside the brand mark so it stays a reusable
// marketing surface — not coupled to /dashboard's route tree.
//
// Animations:
//   • Parent staggers children when the section scrolls into view
//   • Each card fades up from y:24 with an easeOut curve
//   • Hover lifts the card a few pixels; hovering the icon wiggles it
//   • All gated behind `useReducedMotion` for OS-level accessibility opt-out
// ---------------------------------------------------------------------------

import type { ComponentType } from "react";
import {
  FaPenToSquare,
  FaEye,
  FaChartLine,
  FaCommentDots,
} from "react-icons/fa6";
import { motion, useReducedMotion, type Variants } from "motion/react";

// Each feature is just an icon + heading + body. The icon comes from
// react-icons/fa6 to match the platform glyphs already used in onboarding.
type Feature = {
  icon: ComponentType<{ className?: string }>;
  title: string;
  body: string;
};

const FEATURES: Feature[] = [
  {
    icon: FaPenToSquare,
    title: "Drafts platform-perfect posts",
    body: "Give Pincer a three-line brief. It writes a Reddit thread that sounds like a Redditor, a Discord blast that sounds like Discord, and an HN title that won't get flagged.",
  },
  {
    icon: FaEye,
    title: "Watches every post for traction",
    body: "Every 60 seconds, Pincer polls upvotes, views, and new comments across each platform you posted to. Traction lands on your dashboard in real time.",
  },
  {
    icon: FaChartLine,
    title: "Surfaces the analytics that matter",
    body: "Comment velocity, vote curves, platform-by-platform reach. The chart you'd have built manually at 2am, already done by the time you check.",
  },
  {
    icon: FaCommentDots,
    title: "Helps answer comments",
    body: "Pincer reads each new comment, drafts a reply in your voice, and queues it for one-tap approval so threads stay alive while you sleep.",
  },
];

// Parent variant: orchestrates stagger + initial delay so cards don't
// appear in lockstep.
const containerVariants: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.12, delayChildren: 0.1 },
  },
};

// Per-card variant: gentle fade-up. Duration & easing tuned to feel
// editorial rather than springy — matches the landing page's serif voice.
const cardVariants: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: "easeOut" },
  },
};

export function FeaturesShowcase() {
  const reduceMotion = useReducedMotion();

  return (
    <section className="border-t border-foreground/10 px-6 py-20">
      <div className="max-w-5xl mx-auto">
        <h2 className="font-sans text-sm uppercase tracking-wider text-foreground/50 text-center mb-12">
          What Pincer does
        </h2>

        {/* whileInView so the entrance fires when the user scrolls down
            from the hero — landing pages have a tall hero, so animating on
            mount would have the user miss the effect entirely. */}
        <motion.ul
          className="grid grid-cols-1 sm:grid-cols-2 gap-5"
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-80px" }}
          variants={containerVariants}
        >
          {FEATURES.map((feature) => (
            <FeatureCard
              key={feature.title}
              feature={feature}
              reduceMotion={reduceMotion ?? false}
            />
          ))}
        </motion.ul>
      </div>
    </section>
  );
}

function FeatureCard({
  feature,
  reduceMotion,
}: {
  feature: Feature;
  reduceMotion: boolean;
}) {
  const Icon = feature.icon;

  return (
    <motion.li
      variants={cardVariants}
      whileHover={
        reduceMotion
          ? undefined
          : { y: -3, transition: { duration: 0.22, ease: "easeOut" } }
      }
      className="rounded-xl border border-foreground/10 bg-card p-6 flex gap-4 items-start"
    >
      {/* Tinted icon square. Uses --brand for both fill and tinted
          background so the four cards stay visually unified instead of
          turning into a rainbow. Wiggle on hover invites interaction. */}
      <motion.div
        className="shrink-0 size-11 rounded-lg flex items-center justify-center text-xl"
        style={{
          background: "color-mix(in oklab, var(--brand) 12%, transparent)",
          color: "var(--brand)",
        }}
        whileHover={
          reduceMotion
            ? undefined
            : {
                rotate: [0, -8, 8, 0],
                transition: { duration: 0.55, ease: "easeInOut" },
              }
        }
      >
        <Icon />
      </motion.div>

      <div>
        <h3 className="font-serif text-lg tracking-tight">{feature.title}</h3>
        <p className="text-sm text-foreground/65 leading-relaxed mt-1.5">
          {feature.body}
        </p>
      </div>
    </motion.li>
  );
}
