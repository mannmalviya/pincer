// ---------------------------------------------------------------------------
// PincerMark — the brand glyph, reusable across landing, onboarding, dashboard.
//
// HN-orange square with two white pincer arms closing toward the centre.
// Keeping it as a pure SVG component (no image asset) means it scales, prints,
// and tints cleanly. Identical construction style to career-gap's BridgeMark.
// ---------------------------------------------------------------------------
export function PincerMark({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 32 32"
      className={className}
      aria-hidden
    >
      <rect width="32" height="32" fill="#ff6600" />
      <path
        d="M 7 7 Q 16 7 16 14"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <path
        d="M 25 7 Q 16 7 16 14"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <path
        d="M 7 25 Q 16 25 16 18"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.7"
        strokeLinecap="round"
      />
      <path
        d="M 25 25 Q 16 25 16 18"
        fill="none"
        stroke="#ffffff"
        strokeWidth="2.7"
        strokeLinecap="round"
      />
    </svg>
  );
}
