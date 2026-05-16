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
// dash streams so the wires don't march in lockstep.
type PlatformNode = {
  id: string;
  icon: ComponentType<{ className?: string; style?: CSSProperties }>;
  color: string;
  y: number;
  delay: string;
};

// The five sources stacked along the left edge. They feed into Pincer.
const LEFT_X = 8;
const PLATFORMS: PlatformNode[] = [
  { id: "reddit",  icon: FaReddit,     color: "#FF4500",      y: 8,  delay: "0s"   },
  { id: "hn",      icon: FaHackerNews, color: "#FF6600",      y: 29, delay: "0.3s" },
  { id: "discord", icon: FaDiscord,    color: "#5865F2",      y: 50, delay: "0.6s" },
  { id: "bluesky", icon: FaBluesky,    color: "#0085FF",      y: 71, delay: "0.9s" },
  { id: "github",  icon: FaGithub,     color: "currentColor", y: 92, delay: "1.2s" },
];

// Pincer hub, sits left of geometric center to make room on the right
// for the Nemotron Models box.
const CENTER = { x: 38, y: 50 };

// Right-side box that frames the LLM agents. The Pincer wire enters
// this box at the Orchestrator on the left edge; the Orchestrator
// then fans out to the three specialized agents on the right.
const BOX = { left: 50, top: 14, right: 98, bottom: 86 };

// Orchestrator sits just inside the box's left edge so the incoming
// wire from Pincer visibly crosses the box border.
const ORCHESTRATOR = { id: "orch", label: "Orchestrator", x: 58, y: 50, delay: "0.4s" };

// The three downstream specialists, stacked vertically against the
// right side of the box. Each receives a short internal wire from
// the orchestrator.
type AgentNode = { id: string; label: string; x: number; y: number; delay: string };
const AGENTS: AgentNode[] = [
  { id: "drafter",    label: "Drafter",    x: 87, y: 27, delay: "0.7s" },
  { id: "classifier", label: "Classifier", x: 87, y: 50, delay: "0.9s" },
  { id: "replier",    label: "Replier",    x: 87, y: 73, delay: "1.1s" },
];

// Single beam color shared by every wire so the whole diagram reads
// as one connected data flow.
const BEAM_COLOR = "#0369a1";

export function PlatformBeams() {
  return (
    <div className="relative w-full max-w-4xl mx-auto aspect-[3/2]">
      {/* z-0: Nemotron Models box. Sits below the wires so the
          orchestrator-to-agent wires render visibly inside it. */}
      <div
        className="absolute rounded-2xl border border-foreground/15 bg-foreground/[0.02]"
        style={{
          left: `${BOX.left}%`,
          top: `${BOX.top}%`,
          width: `${BOX.right - BOX.left}%`,
          height: `${BOX.bottom - BOX.top}%`,
        }}
        aria-hidden
      />

      {/* Box label, fieldset-legend style: sits on the top border of
          the box with a bg-background backplate so the border visually
          breaks behind it. */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2 px-3 bg-background"
        style={{
          left: `${(BOX.left + BOX.right) / 2}%`,
          top: `${BOX.top}%`,
        }}
      >
        <span className="font-sans text-xs uppercase tracking-[0.2em] text-foreground/55 whitespace-nowrap">
          Nemotron Models
        </span>
      </div>

      {/* z-10: all wires. SVG covers the whole diagram so wire
          coordinates and HTML element percentages share the same
          coordinate system. */}
      <svg
        className="absolute inset-0 w-full h-full overflow-visible"
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        aria-hidden
      >
        {/* Platforms to Pincer. Each curve bows gently into the hub. */}
        {PLATFORMS.map((n) => {
          const cx = (LEFT_X + CENTER.x) / 2;
          const d = `M ${LEFT_X} ${n.y} Q ${cx} ${n.y} ${CENTER.x} ${CENTER.y}`;
          return <Beam key={n.id} d={d} delay={n.delay} />;
        })}

        {/* Pincer to Orchestrator. Short horizontal wire that crosses
            the box's left border, reading as data entering the model
            cluster. */}
        <Beam
          d={`M ${CENTER.x} ${CENTER.y} L ${ORCHESTRATOR.x} ${ORCHESTRATOR.y}`}
          delay={ORCHESTRATOR.delay}
        />

        {/* Orchestrator to each specialist. Straight diagonals so the
            internal fan-out is immediately readable as one source to
            many. */}
        {AGENTS.map((a) => (
          <Beam
            key={a.id}
            d={`M ${ORCHESTRATOR.x} ${ORCHESTRATOR.y} L ${a.x} ${a.y}`}
            delay={a.delay}
          />
        ))}
      </svg>

      {/* z-20: platform icons. Rounded chip with bg-background so the
          icon punches through the wire underneath it cleanly. */}
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

      {/* Orchestrator bubble. Slightly emphasized (brand-tinted border
          and font-medium label) since it's the entry point into the
          model cluster. */}
      <AgentChip
        x={ORCHESTRATOR.x}
        y={ORCHESTRATOR.y}
        label={ORCHESTRATOR.label}
        emphasis
      />

      {/* The three specialist agents on the right side of the box. */}
      {AGENTS.map((a) => (
        <AgentChip key={a.id} x={a.x} y={a.y} label={a.label} />
      ))}

      {/* The Pincer mark, the hub all platform beams flow through. */}
      <div
        className="absolute -translate-x-1/2 -translate-y-1/2"
        style={{ left: `${CENTER.x}%`, top: `${CENTER.y}%` }}
      >
        <PincerMark className="w-20 h-20 rounded-lg shadow-[0_0_28px_-4px_rgba(255,102,0,0.45)]" />
      </div>
    </div>
  );
}

// Reusable pill for the agents inside the Nemotron Models box.
// `emphasis` switches the border to the beam color so the Orchestrator
// stands out as the entry point.
function AgentChip({
  x,
  y,
  label,
  emphasis = false,
}: {
  x: number;
  y: number;
  label: string;
  emphasis?: boolean;
}) {
  return (
    <div
      className={
        "absolute -translate-x-1/2 -translate-y-1/2 px-3 py-1.5 rounded-full bg-background flex items-center justify-center shadow-sm border " +
        (emphasis ? "border-[color:var(--beam-border)]" : "border-foreground/15")
      }
      style={
        {
          left: `${x}%`,
          top: `${y}%`,
          ["--beam-border" as string]: `${BEAM_COLOR}99`,
        } as CSSProperties
      }
    >
      <span
        className={
          "font-mono text-xs tracking-tight whitespace-nowrap " +
          (emphasis ? "text-foreground font-medium" : "text-foreground/80")
        }
      >
        {label}
      </span>
    </div>
  );
}

// Single beam: a dashed wire whose dash pattern slides along the path
// so it reads as packets streaming through. Dash sizes are in raw
// viewBox units (no pathLength normalization, no non-scaling-stroke)
// because those features render dashes inconsistently across straight
// vs curved Bezier paths in some browsers. Result: identical dash
// rhythm on every wire. Per-call delay staggers the streams across
// the diagram so they don't march in lockstep.
function Beam({ d, delay }: { d: string; delay: string }) {
  return (
    <path
      className="beam-anim"
      d={d}
      fill="none"
      stroke={BEAM_COLOR}
      strokeWidth={0.6}
      strokeLinecap="round"
      strokeDasharray="3 3"
      style={{
        animationDelay: delay,
        filter: `drop-shadow(0 0 0.8px ${BEAM_COLOR})`,
      }}
    />
  );
}
