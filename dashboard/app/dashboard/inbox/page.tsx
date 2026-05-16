// Placeholder — the inbox lights up once `poll-comments` + `classify-comment`
// + `escalate-to-human` are landed. See PLAN.md §"Skills to build".

import { PlaceholderSection } from "../_components/placeholder-section";

export default function InboxPage() {
  return (
    <PlaceholderSection
      label="Inbox"
      title="Triage the hard comments."
      body="Comments classified as `needs_human` will surface here with a Nemotron-drafted suggested reply. You edit, you approve, the agent sends. FAQ-style and spam comments stay out of your way."
    />
  );
}
