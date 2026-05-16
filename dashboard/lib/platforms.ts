import type { ComponentType } from "react";
import {
  FaReddit,
  FaHackerNews,
  FaDiscord,
  FaBluesky,
  FaInstagram,
  FaTiktok,
} from "react-icons/fa6";

// ---------------------------------------------------------------------------
// Shared platform metadata.
//
// Onboarding sets the user's selected platforms; the New Post page reads
// them back. Both ends import from here so the union, the display order,
// and the localStorage key never drift apart.
//
// Adding a new platform: extend Platform, add to PLATFORM_ORDER and
// PLATFORM_META, and add to LOGIN_URLS in browser-sidecar/app.py.
// ---------------------------------------------------------------------------

export type Platform = "reddit" | "hn" | "discord" | "bluesky" | "instagram" | "tiktok";

export const PLATFORM_ORDER: Platform[] = [
  "reddit",
  "hn",
  "discord",
  "bluesky",
  "instagram",
  "tiktok",
];

// Display metadata for the onboarding cards + New Post platform pills.
//
// `icon`  : react-icons component for the brand glyph.
// `color` : official brand color, inlined so the glyph renders in its true
//           hue regardless of theme tokens.
// `badge` : small uppercase tag for platforms that don't have a working
//           post path yet. Currently only Reddit + HN can publish; the
//           others can be selected and logged into for future work.
export type PlatformMeta = {
  label: string;
  tagline: string;
  badge?: string;
  icon: ComponentType<{ className?: string; style?: React.CSSProperties }>;
  color: string;
  // When true, the platform cannot be selected in onboarding. Used for the
  // platforms where neither login nor posting is implemented yet, so we
  // don't tempt users into picking something that does nothing.
  disabled?: boolean;
};

export const PLATFORM_META: Record<Platform, PlatformMeta> = {
  reddit: {
    label: "Reddit",
    tagline: "Submit to subreddits, monitor comments and karma over time.",
    icon: FaReddit,
    color: "#FF4500",
  },
  hn: {
    label: "Hacker News",
    tagline: "Show HN / Ask HN submissions, score and comment polling.",
    icon: FaHackerNews,
    color: "#FF6600",
  },
  discord: {
    label: "Discord",
    tagline: "Announce launches to your server.",
    badge: "soon",
    icon: FaDiscord,
    color: "#5865F2",
  },
  bluesky: {
    label: "Bluesky",
    tagline: "Posts and replies at launch via the AT Protocol.",
    badge: "soon",
    icon: FaBluesky,
    color: "#0085FF",
    disabled: true,
  },
  instagram: {
    label: "Instagram",
    tagline: "Posts and Stories from a Business account.",
    badge: "soon",
    icon: FaInstagram,
    color: "#E4405F",
    disabled: true,
  },
  tiktok: {
    label: "TikTok",
    tagline: "Content Posting API. Sandbox by default.",
    badge: "soon",
    icon: FaTiktok,
    color: "currentColor",
    disabled: true,
  },
};

// Platforms that the sidecar's /post endpoint can actually publish to today.
// Used by the New Post page to disable the Publish action for selections
// that would just no-op at the sidecar.
export const PUBLISHABLE_PLATFORMS: ReadonlySet<Platform> = new Set([
  "reddit",
  "hn",
]);

// localStorage key that onboarding writes and the New Post page reads.
// Single source of truth so a typo in one place can't silently break the
// hand-off. Versioned with `v1` so a future schema change (e.g. switching
// to an object with per-platform settings) can use `v2` and ignore stale
// entries without colliding.
export const SELECTED_PLATFORMS_KEY = "pincer:selected-platforms:v1";

// Safe parse: returns [] if the value is missing, malformed, or contains
// platforms that no longer exist. Used by the New Post page on mount.
export function loadSelectedPlatforms(): Platform[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(SELECTED_PLATFORMS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const allowed = new Set<string>(PLATFORM_ORDER);
    return parsed.filter(
      (p): p is Platform => typeof p === "string" && allowed.has(p),
    );
  } catch {
    return [];
  }
}

export function saveSelectedPlatforms(platforms: Platform[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    SELECTED_PLATFORMS_KEY,
    JSON.stringify(platforms),
  );
}
