/**
 * GET /api/auth/github/status
 *
 * Server-side proxy to the agent's /integrations/github/status. We
 * proxy (instead of letting the browser fetch the agent directly)
 * because the agent runs on a Brev secure-link URL whose CORS / auth
 * behaviour for browser preflights is unreliable. A server-side Next
 * fetch sidesteps that.
 */
import { NextResponse } from "next/server";

const AGENT_BASE =
  process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8000";

export async function GET() {
  try {
    const res = await fetch(`${AGENT_BASE}/integrations/github/status`, {
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({
        connected: false,
        agent_reachable: false,
      });
    }
    const data = (await res.json()) as { connected: boolean; login?: string };
    return NextResponse.json({ ...data, agent_reachable: true });
  } catch {
    return NextResponse.json({ connected: false, agent_reachable: false });
  }
}
