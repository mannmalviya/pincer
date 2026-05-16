/**
 * POST /api/auth/github/disconnect
 *
 * Server-side proxy to the agent's /integrations/github/disconnect.
 * Same rationale as /status: a Next.js server fetch sidesteps Brev's
 * browser-side CORS / auth-wall behaviour.
 *
 * Note: this only forgets the token locally. To fully revoke Pincer's
 * access, the user also has to remove the OAuth App from
 * github.com/settings/applications. We surface that link in the UI.
 */
import { NextResponse } from "next/server";

const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000";

export async function POST() {
  try {
    const res = await fetch(
      `${AGENT_BASE}/integrations/github/disconnect`,
      { method: "POST" },
    );
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, error: "agent_error" },
        { status: 502 },
      );
    }
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: "agent_unreachable" },
      { status: 502 },
    );
  }
}
