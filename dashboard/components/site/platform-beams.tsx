"use client";

import type { ComponentType, CSSProperties } from "react";
import {
  FaReddit,
  FaHackerNews,
  FaDiscord,
  FaBluesky,
  FaGithub,
} from "react-icons/fa6";

import { PincerMark } from "./pincer-mark";

// Each platform node sits at (x, y) as a percentage of the diagram box.
// The SVG wire layer uses the same percentages via viewBox="0 0 100 100"
// so the two stay aligned at any container size. `delay` staggers the
// pulses so the beams don't fire in unison.
type PlatformNode = {
  id: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  color: string;
  y: number;
  delay: string;
};

// The five sources stacked along the left edge. They feed into Pincer.
const LEFT_X = 10;
const PLATFORMS: PlatformNode[] = [
  { id: "reddit",  icon: FaReddit,     color: "#FF4500",     y: 8,  delay: "0s"   },
  { id: "hn",      icon: FaHackerNews, color: "#FF6600",     y: 29, delay: "0.3s" },
  { id: "discord", icon: FaDiscord,    color: "#5865F2",     y: 50, delay: "0.6s" },
  { id: "bluesky", icon: FaBluesky,    color: "#0085FF",     y: 71, delay: "0.9s" },
  { id: "github",  icon: FaGithub,     color: "currentColor",y: 92, delay: "1.2s" },
];

// Right-side infrastructure stack, drawn as a linear chain:
// Pincer → NemoClaw → OpenClaw. The wires represent the runtime stack
// Pincer rides on top of, so each node hands off to the next rather
// than fanning out from the hub. Coordinates set so the chain reads
// horizontally and the OpenClaw bubble doesn't clip the right edge.
type StackNode = { id: string; label: string; x: number; y: number; delay: string };
const STACK: StackNode[] = [
  { id: "nemoclaw", label: "NemoClaw", x: 70, y: 50, delay: "0.4s" },
  { id: "openclaw", label: "OpenClaw", x: 90, y: 50, delay: "1.1s" },
];

const CENTER = { x: 50, y: 50 };

// Single beam color shared by every wire, so the diagram reads as a
// uniform "data is flowing" current rather than six separate streams.
// sky-400; bright enough to glow on the warm background and not clash
// with any platform brand color.
const BEAM_COLOR = "#38bdf8";

export function PlatformBeams() {
  return (
    <div className="relative w-full max-w-2xl mx-auto aspect-square">
      {/* Wires + traveling pulses. Quadratic Bezier with the control
          point pulled toward the node's y gives a gentle horizontal bow
          into the center, more interesting than a straight line. */}
      <svg
        className="absolute inset-0 w-full h-full overflow-visible"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        {/* Left-side beams: platforms → Pincer. */}
        {PLATFORMS.map((n) => {
          const cx = (LEFT_X + CENTER.x) / 2;
          const d = `M ${LEFT_X} ${n.y} Q ${cx} ${n.y} ${CENTER.x} ${CENTER.y}`;
          return <Beam key={n.id} d={d} delay={n.delay} />;
        })}

        {/* Right-side beams: linear chain Pincer → NemoClaw → OpenClaw.
            Each path starts at the previous node (or Pincer for the
            first segment) so the pulses look like a relay handing off
            outward instead of two parallel streams from the hub. */}
        {STACK.map((n, i) => {
          const prev = i === 0 ? CENTER : STACK[i - 1];
          const cx = (prev.x + n.x) / 2;
          const d = `M ${prev.x} ${prev.y} Q ${cx} ${n.y} ${n.x} ${n.y}`;
          return <Beam key={n.id} d={d} delay={n.delay} />;
        })}
      </svg>

      {/* Platform icons, positioned at the same percentages as the SVG
          coords. Rounded chip with bg-background so the icon punches
          through the beam trails cleanly. */}
      {PLATFORMS.map((n) => {
        const Icon = n.icon;
        return (
          <div
            key={n.id}
            className="absolute -translate-x-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-background border border-foreground/15 flex items-center justify-center shadow-sm"
            style={{ left: `${LEFT_X}%`, top: `${n.y}%` }}
          >
            <Icon className="text-xl" style={{ color: n.color }} aria-hidden />
          </div>
        );
      })}

      {/* Right-side infrastructure bubbles, positioned at each node's
          own (x, y). Same blue accent as the beams so the whole chain
          reads as part of the data-flow rather than separate chips. */}
      {STACK.map((n) => (
        <div
          key={n.id}
          className="absolute -translate-x-1/2 -translate-y-1/2 px-3 py-1.5 rounded-full bg-background border border-[color:var(--beam-border)] flex items-center justify-center shadow-sm"
          style={
            {
              left: `${n.x}%`,
              top: `${n.y}%`,
              ["--beam-border" as string]: `${BEAM_COLOR}66`,
            } as CSSProperties
          }
        >
          <span className="font-mono text-xs tracking-tight text-foreground/80 whitespace-nowrap">
            {n.label}
          </span>
        </div>
      ))}

      {/* The Pincer mark, the hub all beams flow through. Slightly
          larger than the side chips with a soft brand glow so it reads
          as the focal point. */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
      >
        <PincerMark className="w-20 h-20 rounded-lg shadow-[0_0_28px_-4px_rgba(255,102,0,0.45)]" />
      </div>
    </div>
  );
}

// Single beam: faint background trail + a glowing dash traveling end to
// end. Extracted so left and right sides share the exact same styling.
function Beam({ d, delay }: { d: string; delay: string }) {
  return (
    <g>
      {/* Always-on glowing wire. Higher opacity + drop-shadow filter so
          the whole path reads as a lit-up data channel, not just where
          the traveling pulse currently is. */}
      <path
        d={d}
        pathLength={100}
        fill="none"
        stroke={BEAM_COLOR}
        strokeOpacity={0.85}
        strokeWidth={1}
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        style={{
          filter: `drop-shadow(0 0 4px ${BEAM_COLOR}) drop-shadow(0 0 8px ${BEAM_COLOR})`,
        }}
      />
      <path
        className="beam-anim"
        d={d}
        pathLength={100}
        fill="none"
        stroke={BEAM_COLOR}
        strokeWidth={1.4}
        strokeLinecap="round"
        strokeDasharray="6 100"
        vectorEffect="non-scaling-stroke"
        style={{
          animationDelay: delay,
          filter: `drop-shadow(0 0 5px ${BEAM_COLOR}) drop-shadow(0 0 10px ${BEAM_COLOR})`,
        }}
      />
    </g>
  );
}